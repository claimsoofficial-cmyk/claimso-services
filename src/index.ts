import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { OpenAI } from 'openai'
import { PDFDocument, rgb, StandardFonts, PageSizes } from 'pdf-lib'
import { PKPass } from 'passkit-generator'
import { createEvent } from 'ics'

// ==============================================================================
// ENVIRONMENT VARIABLE TYPE DECLARATIONS
// ==============================================================================

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      SERVICES_API_KEY: string;
      PASS_TYPE_IDENTIFIER: string;
      APPLE_TEAM_ID: string;
      PASSKIT_CERT: string;
      PASSKIT_KEY: string;
      PASSKIT_KEY_PASSPHRASE: string;
      WWDR_CERT: string;
      OPENAI_API_KEY: string;
    }
  }
}

// ==============================================================================
// ENVIRONMENT VALIDATION
// ==============================================================================

function getRequiredEnvVar(key: string): string {
  const value = process.env[key as keyof typeof process.env];
  if (!value || typeof value !== 'string') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getOptionalEnvVar(key: string, defaultValue: string = ''): string {
  const value = process.env[key as keyof typeof process.env];
  return (value && typeof value === 'string') ? value : defaultValue;
}

// ==============================================================================
// TYPESCRIPT INTERFACES
// ==============================================================================

interface AIProcessedProduct {
  product_name: string;
  brand?: string;
  model?: string;
  category?: string;
  purchase_date?: string;
  purchase_price?: number;
  currency?: string;
  purchase_location?: string;
  serial_number?: string;
  condition?: 'new' | 'used' | 'refurbished';
  notes?: string;
}

interface EmailIntent {
  intent: 'PURCHASE' | 'RETURN' | 'SHIPMENT_UPDATE';
}

interface OrderStatusUpdate {
  order_id: string;
  status: string;
  tracking_number?: string;
  estimated_delivery?: string;
  notes?: string;
}

interface EmailContent {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
}

interface Product {
  id: string;
  name: string;
  brand?: string;
  serial_number?: string;
  purchase_date?: string;
  order_number?: string;
  retailer?: string;
  price?: number;
  currency?: string;
  category?: string;
}

interface GeneratePacketRequest {
  product: Product;
  problemDescription: string;
  user: {
    name: string;
    email: string;
  };
}

interface UserProfile {
  id: string;
  full_name: string | null;
  email: string;
  productCount: number;
}

interface PassTemplate {
  formatVersion: number;
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName: string;
  description: string;
  logoText: string;
  foregroundColor: string;
  backgroundColor: string;
  labelColor: string;
  generic: {
    primaryFields: PassField[];
    secondaryFields: PassField[];
    auxiliaryFields: PassField[];
    backFields: PassField[];
  };
  barcodes: PassBarcode[];
  locations: unknown[];
  maxDistance: number;
  relevantDate: string;
  expirationDate: string;
  serialNumber?: string;
  [key: string]: unknown;
}

interface PassField {
  key: string;
  label: string;
  value: string;
}

// Fixed PassBarcode interface - format is now required
interface PassBarcode {
  message: string;
  format: string; // Required field
  messageEncoding: string;
}

interface CalendarProduct {
  id: string;
  product_name: string;
  purchase_date: string;
  warranty_length_months: number;
}

// ==============================================================================
// UTILITY FUNCTIONS
// ==============================================================================

/**
 * Text sanitization function to prevent injection attacks
 */
function sanitizeText(text: string): string {
  if (!text || typeof text !== 'string') {
    return ''
  }
  
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[<>{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 1000)
}

/**
 * Authorization middleware
 */
function checkAuth(c: any) {
  const authHeader = c.req.header('Authorization')
  const expectedKey = getRequiredEnvVar('SERVICES_API_KEY')
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing Authorization header' }, 401)
  }
  
  const providedKey = authHeader.slice(7)
  if (providedKey !== expectedKey) {
    return c.json({ error: 'Invalid API key' }, 401)
  }
  
  return null
}

// ==============================================================================
// AI PROCESSING FUNCTIONS
// ==============================================================================

/**
 * AI prompt for email intent classification
 */
const EMAIL_CLASSIFICATION_PROMPT = `You are an expert at classifying email types from retailers and e-commerce platforms.

Your task is to analyze the provided email content and determine the intent. Return ONLY a valid JSON object with this structure:

{
  "intent": "PURCHASE" | "RETURN" | "SHIPMENT_UPDATE"
}

Classification rules:
- PURCHASE: New purchase confirmations, order confirmations, receipts for new purchases
- RETURN: Return confirmations, refund notifications, return shipping labels
- SHIPMENT_UPDATE: Shipping notifications, delivery updates, tracking information, "your order has shipped" emails

Return only the JSON object with the intent field. Do not include any other text or explanation.

Email content to classify:`

/**
 * Calls OpenAI to classify email intent
 */
async function classifyEmailIntent(openai: OpenAI, subject: string, text: string): Promise<EmailIntent | null> {
  try {
    const emailContent = `Subject: ${subject}\n\nBody:\n${text}`
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: EMAIL_CLASSIFICATION_PROMPT
        },
        {
          role: 'user',
          content: emailContent
        }
      ],
      temperature: 0.1,
      max_tokens: 50,
    })

    const responseText = completion.choices[0]?.message?.content?.trim()
    if (!responseText) {
      throw new Error('No response from OpenAI classification')
    }

    const parsed = JSON.parse(responseText) as EmailIntent
    
    if (!parsed.intent || !['PURCHASE', 'RETURN', 'SHIPMENT_UPDATE'].includes(parsed.intent)) {
      throw new Error('Invalid intent in classification response')
    }

    return parsed
  } catch (error) {
    console.error('Email classification error:', error)
    return null
  }
}

/**
 * AI parsing prompt for receipt data extraction
 */
const RECEIPT_PARSING_PROMPT = `You are an expert at parsing receipt and purchase confirmation emails. 

Your task is to analyze the provided email content and extract product purchase information. Return ONLY a valid JSON object with the following structure:

{
  "product_name": "string (required - the main product name)",
  "brand": "string (optional - brand/manufacturer)",
  "model": "string (optional - specific model number)",
  "category": "string (optional - product category like 'Electronics', 'Clothing', etc.)",
  "purchase_date": "string (optional - ISO date format YYYY-MM-DD)",
  "purchase_price": "number (optional - price as number without currency symbols)",
  "currency": "string (optional - currency code like 'USD', 'EUR')",
  "purchase_location": "string (optional - store name or website)",
  "serial_number": "string (optional - if mentioned in email)",
  "condition": "string (optional - 'new', 'used', 'refurbished')",
  "notes": "string (optional - any additional relevant details)"
}

Rules:
- If you cannot identify a clear product purchase, return: {"product_name": "Unknown Purchase"}
- Only include fields where you have confidence in the data
- For purchase_price, extract only the numeric value (e.g., 29.99 not "$29.99")
- For purchase_date, convert to YYYY-MM-DD format if possible
- Be conservative - don't guess if you're not confident about a field

Email content to analyze:`

/**
 * Calls OpenAI to parse receipt content
 */
async function parseReceiptWithAI(openai: OpenAI, subject: string, text: string): Promise<AIProcessedProduct | null> {
  try {
    const emailContent = `Subject: ${subject}\n\nBody:\n${text}`
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: RECEIPT_PARSING_PROMPT
        },
        {
          role: 'user',
          content: emailContent
        }
      ],
      temperature: 0.1,
      max_tokens: 500,
    })

    const responseText = completion.choices[0]?.message?.content?.trim()
    if (!responseText) {
      throw new Error('No response from OpenAI')
    }

    const parsed = JSON.parse(responseText) as AIProcessedProduct
    
    if (!parsed.product_name) {
      throw new Error('No product_name in AI response')
    }

    return parsed
  } catch (error) {
    console.error('AI parsing error:', error)
    return {
      product_name: `Email Purchase: ${subject}`,
      notes: `Automated extraction failed. Original content: ${text.substring(0, 500)}...`,
    }
  }
}

/**
 * AI prompt for order status update extraction
 */
const STATUS_UPDATE_PARSING_PROMPT = `You are an expert at parsing shipping and return status emails from retailers.

Your task is to analyze the provided email content and extract order status information. Return ONLY a valid JSON object with the following structure:

{
  "order_id": "string (required - order number, confirmation number, or return ID)",
  "status": "string (required - current status like 'shipped', 'delivered', 'returned', 'refunded')",
  "tracking_number": "string (optional - tracking/reference number if provided)",
  "estimated_delivery": "string (optional - delivery date in YYYY-MM-DD format)",
  "notes": "string (optional - additional status details)"
}

Rules:
- Extract the most specific order identifier available (order number, confirmation code, etc.)
- For status, use clear terms like: 'shipped', 'delivered', 'out_for_delivery', 'returned', 'refunded', 'processing'
- Only include fields where you have confidence in the data
- Be conservative - don't guess if you're not confident about a field

Email content to analyze:`

/**
 * Calls OpenAI to parse status update content
 */
async function parseStatusUpdateWithAI(openai: OpenAI, subject: string, text: string): Promise<OrderStatusUpdate | null> {
  try {
    const emailContent = `Subject: ${subject}\n\nBody:\n${text}`
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: STATUS_UPDATE_PARSING_PROMPT
        },
        {
          role: 'user',
          content: emailContent
        }
      ],
      temperature: 0.1,
      max_tokens: 300,
    })

    const responseText = completion.choices[0]?.message?.content?.trim()
    if (!responseText) {
      throw new Error('No response from OpenAI status parsing')
    }

    const parsed = JSON.parse(responseText) as OrderStatusUpdate
    
    if (!parsed.order_id || !parsed.status) {
      throw new Error('Missing required fields in status update response')
    }

    return parsed
  } catch (error) {
    console.error('AI status parsing error:', error)
    return null
  }
}

// ==============================================================================
// PDF GENERATION FUNCTIONS
// ==============================================================================

/**
 * Main PDF generation function
 */
async function generateWarrantyClaimPacket(request: GeneratePacketRequest): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage(PageSizes.Letter)
  const { width, height } = page.getSize()
  
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica)
  
  const blackColor = rgb(0, 0, 0)
  const grayColor = rgb(0.4, 0.4, 0.4)
  const blueColor = rgb(0.2, 0.4, 0.8)
  
  let yPosition = height - 50
  
  const addText = (text: string, x: number, fontSize: number, font = regularFont, color = blackColor) => {
    page.drawText(text, {
      x,
      y: yPosition,
      size: fontSize,
      font,
      color,
    })
    yPosition -= fontSize + 5
  }
  
  const addSectionSpacing = (spacing: number = 20) => {
    yPosition -= spacing
  }
  
  // Header Section
  addText('WARRANTY CLAIM PACKET', 50, 24, boldFont, blueColor)
  addText('CLAIMSO', width - 150, 16, boldFont, grayColor)
  addSectionSpacing(10)
  
  page.drawLine({
    start: { x: 50, y: yPosition },
    end: { x: width - 50, y: yPosition },
    thickness: 1,
    color: grayColor,
  })
  addSectionSpacing(20)
  
  // Generation Date
  const currentDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
  addText(`Generated: ${currentDate}`, 50, 12, regularFont, grayColor)
  addSectionSpacing()
  
  // Prepared For Section
  addText('PREPARED FOR:', 50, 14, boldFont)
  addText(sanitizeText(request.user.name), 70, 12)
  addText(sanitizeText(request.user.email), 70, 12, regularFont, grayColor)
  addSectionSpacing()
  
  // Product Details Section
  addText('PRODUCT DETAILS:', 50, 14, boldFont)
  addSectionSpacing(5)
  
  const productDetails = [
    ['Product Name:', sanitizeText(request.product.name || 'N/A')],
    ['Brand:', sanitizeText(request.product.brand || 'N/A')],
    ['Category:', sanitizeText(request.product.category || 'N/A')],
    ['Serial Number:', sanitizeText(request.product.serial_number || 'N/A')],
  ]
  
  productDetails.forEach(([label, value]) => {
    page.drawText(label!, { x: 70, y: yPosition, size: 11, font: boldFont })
    page.drawText(value!, { x: 200, y: yPosition, size: 11, font: regularFont })
    yPosition -= 16
  })
  addSectionSpacing()
  
  // Purchase Information Section
  addText('PURCHASE INFORMATION:', 50, 14, boldFont)
  addSectionSpacing(5)
  
  const purchaseInfo = [
    ['Purchase Date:', sanitizeText(request.product.purchase_date || 'N/A')],
    ['Retailer:', sanitizeText(request.product.retailer || 'N/A')],
    ['Order Number:', sanitizeText(request.product.order_number || 'N/A')],
    ['Price:', request.product.price ? `${request.product.currency || '$'}${request.product.price}` : 'N/A'],
  ]
  
  purchaseInfo.forEach(([label, value]) => {
    page.drawText(label!, { x: 70, y: yPosition, size: 11, font: boldFont })
    page.drawText(value!, { x: 200, y: yPosition, size: 11, font: regularFont })
    yPosition -= 16
  })
  addSectionSpacing()
  
  // Problem Description Section
  addText('PROBLEM DESCRIPTION:', 50, 14, boldFont)
  addSectionSpacing(5)
  
  const sanitizedDescription = sanitizeText(request.problemDescription)
  const maxLineWidth = width - 140
  const words = sanitizedDescription.split(' ')
  let currentLine = ''
  
  words.forEach(word => {
    const testLine = currentLine + (currentLine ? ' ' : '') + word
    const lineWidth = regularFont.widthOfTextAtSize(testLine, 11)
    
    if (lineWidth > maxLineWidth && currentLine) {
      addText(`"${currentLine}"`, 70, 11, regularFont)
      currentLine = word
    } else {
      currentLine = testLine
    }
  })
  
  if (currentLine) {
    addText(`"${currentLine}"`, 70, 11, regularFont)
  }
  addSectionSpacing()
  
  // Supporting Evidence Section
  addText('SUPPORTING EVIDENCE:', 50, 14, boldFont)
  addSectionSpacing(5)
  addText('Photos/videos available upon request.', 70, 11, regularFont, grayColor)
  addText('Additional documentation can be provided as needed.', 70, 11, regularFont, grayColor)
  addSectionSpacing()
  
  // Footer
  yPosition = 50
  page.drawLine({
    start: { x: 50, y: yPosition + 20 },
    end: { x: width - 50, y: yPosition + 20 },
    thickness: 1,
    color: grayColor,
  })
  
  page.drawText('Generated by CLAIMSO', {
    x: 50,
    y: yPosition,
    size: 10,
    font: regularFont,
    color: grayColor,
  })
  
  page.drawText(`Document ID: ${request.product.id}-${Date.now()}`, {
    x: width - 200,
    y: yPosition,
    size: 10,
    font: regularFont,
    color: grayColor,
  })
  
  const pdfBytes = await pdfDoc.save()
  return pdfBytes
}

// ==============================================================================
// APPLE WALLET PASS GENERATION FUNCTIONS
// ==============================================================================

/**
 * Generates a simple default icon as a fallback
 */
async function generateDefaultIcon(): Promise<Buffer> {
  const svgIcon = `
    <svg width="29" height="29" viewBox="0 0 29 29" xmlns="http://www.w3.org/2000/svg">
      <rect width="29" height="29" rx="6" fill="#2563eb"/>
      <path d="M14.5 7L19 11.5L14.5 16L10 11.5L14.5 7Z" fill="white"/>
      <rect x="10" y="17" width="9" height="2" rx="1" fill="white"/>
      <rect x="12" y="20" width="5" height="1.5" rx="0.75" fill="white"/>
    </svg>
  `
  
  return Buffer.from(svgIcon, 'utf-8')
}

/**
 * Loads pass template and assets
 */
async function loadPassAssets(): Promise<{ passJson: PassTemplate; iconBuffer: Buffer }> {
  const passJson: PassTemplate = {
    formatVersion: 1,
    passTypeIdentifier: getOptionalEnvVar('PASS_TYPE_IDENTIFIER', 'pass.com.claimso.smartpass'),
    teamIdentifier: getOptionalEnvVar('APPLE_TEAM_ID', 'YOUR_TEAM_ID'),
    organizationName: 'CLAIMSO',
    description: 'CLAIMSO Smart Pass - Personal Warranty Assistant',
    logoText: 'CLAIMSO',
    foregroundColor: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(37, 99, 235)',
    labelColor: 'rgb(255, 255, 255)',
    generic: {
      primaryFields: [
        {
          key: 'title',
          label: 'Smart Pass',
          value: 'Personal Warranty Assistant'
        }
      ],
      secondaryFields: [
        {
          key: 'status',
          label: 'Status',
          value: 'Active'
        },
        {
          key: 'products',
          label: 'Products Protected',
          value: 'Loading...'
        }
      ],
      auxiliaryFields: [
        {
          key: 'member-since',
          label: 'Member Since',
          value: new Date().getFullYear().toString()
        }
      ],
      backFields: [
        {
          key: 'description',
          label: 'About CLAIMSO Smart Pass',
          value: 'Your personal warranty assistant that helps you track purchases, manage warranties, and file claims with confidence.'
        },
        {
          key: 'features',
          label: 'Features',
          value: '• Real-time warranty notifications\n• Automatic receipt processing\n• Smart claim assistance\n• Universal product tracking'
        },
        {
          key: 'support',
          label: 'Support',
          value: 'Need help? Visit claimso.com/support or email hello@claimso.com'
        }
      ]
    },
    barcodes: [
      {
        message: '',
        format: 'PKBarcodeFormatQR', // Required field with explicit value
        messageEncoding: 'iso-8859-1'
      }
    ],
    locations: [],
    maxDistance: 1000,
    relevantDate: new Date(Date.now() + (365 * 24 * 60 * 60 * 1000)).toISOString(),
    expirationDate: new Date(Date.now() + (2 * 365 * 24 * 60 * 60 * 1000)).toISOString(),
  }

  const iconBuffer = await generateDefaultIcon()
  
  return { passJson, iconBuffer }
}

/**
 * Generate Apple Wallet pass
 */
async function generateApplePass(userProfile: UserProfile): Promise<Uint8Array> {
  const assets = await loadPassAssets()
  
  const customizedPassJson: PassTemplate = {
    ...assets.passJson,
    serialNumber: userProfile.id,
    generic: {
      ...assets.passJson.generic,
      secondaryFields: [
        ...assets.passJson.generic.secondaryFields.filter((field: PassField) => field.key !== 'products'),
        {
          key: 'products',
          label: 'Products Protected',
          value: userProfile.productCount.toString()
        }
      ],
      backFields: [
        ...assets.passJson.generic.backFields,
        {
          key: 'user-info',
          label: 'Vault Owner',
          value: `${userProfile.full_name || 'User'}\n${userProfile.email}`
        }
      ]
    },
    barcodes: [
      {
        message: userProfile.id,
        format: 'PKBarcodeFormatQR', // Explicitly set required format
        messageEncoding: 'iso-8859-1'
      }
    ]
  }

  // Use direct environment variable access with explicit checks and non-null assertions
  const passkitCert = process.env['PASSKIT_CERT'];
  const passkitKey = process.env['PASSKIT_KEY'];
  const passkitKeyPassphrase = process.env['PASSKIT_KEY_PASSPHRASE'] || '';
  const wwdrCert = process.env['WWDR_CERT'] || '';

  if (!passkitCert || !passkitKey) {
    throw new Error('Missing required certificate environment variables: PASSKIT_CERT, PASSKIT_KEY');
  }

  const certificates = {
    signerCert: Buffer.from(passkitCert!, 'base64'),
    signerKey: Buffer.from(passkitKey!, 'base64'),
    signerKeyPassphrase: passkitKeyPassphrase,
    wwdr: wwdrCert ? Buffer.from(wwdrCert!, 'base64') : Buffer.alloc(0),
  }

  const pass = new PKPass(
    {
      'icon.png': assets.iconBuffer,
    },
    certificates,
    customizedPassJson as Record<string, unknown>
  )

  const passBuffer = pass.getAsBuffer()
  return new Uint8Array(passBuffer)
}

// ==============================================================================
// HONO APPLICATION SETUP
// ==============================================================================

const app = new Hono()

// ==============================================================================
// ROUTE 1: EMAIL PARSER
// ==============================================================================

app.post('/email-parser', async (c) => {
  const authError = checkAuth(c)
  if (authError) return authError

  try {
    const body = await c.req.json() as EmailContent
    
    if (!body.to || !body.from || !body.subject || !body.text) {
      return c.json({ error: 'Missing required email fields' }, 400)
    }

    const OPENAI_API_KEY = getRequiredEnvVar('OPENAI_API_KEY')
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

    // Stage 1: Classify Email Intent
    const intentResult = await classifyEmailIntent(openai, body.subject, body.text)
    
    if (!intentResult) {
      return c.json({ error: 'Failed to classify email intent' }, 500)
    }

    let result: AIProcessedProduct | OrderStatusUpdate | null = null

    // Stage 2: Process Based on Intent
    switch (intentResult.intent) {
      case 'PURCHASE':
        result = await parseReceiptWithAI(openai, body.subject, body.text)
        break

      case 'RETURN':
      case 'SHIPMENT_UPDATE':
        result = await parseStatusUpdateWithAI(openai, body.subject, body.text)
        break

      default:
        return c.json({ error: `Unsupported email intent: ${intentResult.intent}` }, 400)
    }

    if (!result) {
      return c.json({ error: 'Failed to extract data from email' }, 500)
    }

    return c.json({
      intent: intentResult.intent,
      data: result
    })

  } catch (error) {
    console.error('Email parsing error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ==============================================================================
// ROUTE 2: PDF GENERATOR
// ==============================================================================

app.post('/pdf-generator', async (c) => {
  const authError = checkAuth(c)
  if (authError) return authError

  try {
    const body = await c.req.json() as GeneratePacketRequest
    
    if (!body.product?.id || !body.product?.name || !body.problemDescription || !body.user?.name || !body.user?.email) {
      return c.json({ error: 'Missing required fields' }, 400)
    }

    const pdfBytes = await generateWarrantyClaimPacket(body)
    
    return new Response(pdfBytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': pdfBytes.length.toString(),
      },
    })

  } catch (error) {
    console.error('PDF generation error:', error)
    return c.json({ error: 'Failed to generate PDF' }, 500)
  }
})

// ==============================================================================
// ROUTE 3: PASS GENERATOR
// ==============================================================================

app.post('/pass-generator', async (c) => {
  const authError = checkAuth(c)
  if (authError) return authError

  try {
    const body = await c.req.json() as UserProfile
    
    if (!body.id || !body.email) {
      return c.json({ error: 'Missing required user fields' }, 400)
    }

    const passBytes = await generateApplePass(body)
    
    return new Response(passBytes, {
      headers: {
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Length': passBytes.length.toString(),
      },
    })

  } catch (error) {
    console.error('Pass generation error:', error)
    return c.json({ error: 'Failed to generate pass' }, 500)
  }
})

// ==============================================================================
// ROUTE 4: CALENDAR GENERATOR
// ==============================================================================

app.post('/calendar-generator', async (c) => {
  const authError = checkAuth(c)
  if (authError) return authError

  try {
    const body = await c.req.json() as CalendarProduct
    
    if (!body.id || !body.product_name || !body.purchase_date || !body.warranty_length_months) {
      return c.json({ error: 'Missing required product fields' }, 400)
    }

    const purchaseDate = new Date(body.purchase_date)
    const expirationDate = new Date(purchaseDate)
    expirationDate.setMonth(expirationDate.getMonth() + body.warranty_length_months)

    const event = {
      start: [expirationDate.getFullYear(), expirationDate.getMonth() + 1, expirationDate.getDate()] as [number, number, number],
      duration: { hours: 1 },
      title: `Warranty Expiration: ${body.product_name}`,
      description: `Your warranty for ${body.product_name} expires today.`,
      alarms: [{
        action: 'display' as const,
        description: `Reminder: Warranty expires in 1 week for ${body.product_name}`,
        trigger: { weeks: 1, before: true }
      }]
    }

    const { error: icsError, value: icsContent } = createEvent(event)

    if (icsError || !icsContent) {
      console.error('ICS generation error:', icsError)
      return c.json({ error: 'Failed to generate calendar event' }, 500)
    }
    
    return new Response(icsContent, {
      headers: {
        'Content-Type': 'text/calendar',
        'Content-Length': icsContent.length.toString(),
      },
    })

  } catch (error) {
    console.error('Calendar generation error:', error)
    return c.json({ error: 'Failed to generate calendar event' }, 500)
  }
})

// ==============================================================================
// HEALTH CHECK
// ==============================================================================

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'claimso-services',
    timestamp: new Date().toISOString(),
    features: ['email-parser', 'pdf-generator', 'pass-generator', 'calendar-generator']
  })
})

// ==============================================================================
// ROOT ENDPOINT
// ==============================================================================

app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'claimso-services',
    version: '1.0.0',
    endpoints: {
      'POST /email-parser': 'Parse and classify email content',
      'POST /pdf-generator': 'Generate warranty claim packets',
      'POST /pass-generator': 'Generate Apple Wallet passes', 
      'POST /calendar-generator': 'Generate calendar events',
      'GET /health': 'Health check endpoint'
    }
  })
})

// ==============================================================================
// VERCEL EXPORT
// ==============================================================================

export default handle(app)