import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";
import { isAllowedOrigin } from "./lib/originPolicy";
import { getDeviceIdFromRequest, isValidDeviceId } from "./lib/deviceIdentity";
const app: Express = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.disable("x-powered-by");
app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
});
app.use(pinoHttp({
    logger,
    serializers: {
        req(req) {
            return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
        },
        res(res) {
            return { statusCode: res.statusCode };
        },
    },
}));
app.use((req, res, next) => {
    if (!isAllowedOrigin(req.headers.origin)) {
        res.status(403).json({ error: "Origin is not allowed." });
        return;
    }
    next();
});
app.use(cors({
    origin(origin, callback) {
        callback(null, isAllowedOrigin(origin));
    },
    exposedHeaders: ["X-Device-Id"],
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req: any, res: Response, next: NextFunction) => {
    if (req.path === "/api/healthz") {
        next();
        return;
    }
    const deviceId = getDeviceIdFromRequest(req.headers);
    if (deviceId !== undefined && !isValidDeviceId(deviceId)) {
        res.status(401).json({ error: "Device identity is invalid." });
        return;
    }
    req.deviceId = deviceId;
    next();
});
app.use("/api", router);
const userAppDir = path.join(__dirname, "../public-user-app");
if (fs.existsSync(path.join(userAppDir, "index.html"))) {
    const userAppHtml = fs.readFileSync(path.join(userAppDir, "index.html"), "utf-8")
        .replace(/src="\/assets\//g, 'src="/user-app/assets/')
        .replace(/href="\/assets\//g, 'href="/user-app/assets/')
        .replace('href="/favicon.svg"', 'href="/user-app/favicon.svg"')
        .replace("<head>", `<head><script>(function(){var b='/user-app';if(window.location.pathname.startsWith(b)){var r=window.location.pathname.slice(b.length)||'/';window.history.replaceState(null,'',r+window.location.search+window.location.hash);}}());</script>`);
    app.use("/user-app", express.static(userAppDir, { index: false }));
    app.get(["/user-app", "/user-app/{*path}"], (_req: Request, res: Response) => {
        res.setHeader("Content-Type", "text/html");
        res.send(userAppHtml);
    });
}
export default app;
