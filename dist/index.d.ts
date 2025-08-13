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
declare const _default: (req: Request, requestContext: import("hono/types").FetchEventLike) => Response | Promise<Response>;
export default _default;
//# sourceMappingURL=index.d.ts.map