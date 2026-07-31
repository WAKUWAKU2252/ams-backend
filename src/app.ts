import { Elysia, sse } from "elysia";
import { setup } from "./plugins/setup";
import { authRoutes } from "./modules/auth";
import { purchaseOrderRoutes } from "./modules/purchase-order";
import { assetRequestRoutes } from "./modules/asset-request";
import { uploadRoutes } from "./modules/upload";
import { grpoRoutes } from "./modules/grpo";
import { assetRoutes } from "./modules/asset";
import { userRoutes } from "./modules/user";
import { eventsRoutes } from "./events/events.routes";

// ประกอบ app ทั้งหมด — แยกจาก listen() เพื่อให้ test เรียก createApp().handle(...) ได้
export const createApp = () =>
  new Elysia()
    .use(setup)
    .get("/health", () => ({ status: "ok" }))
    .use(eventsRoutes)
    .use(authRoutes)
    .use(purchaseOrderRoutes)
    .use(assetRequestRoutes)
    .use(uploadRoutes)
    .use(grpoRoutes)
    .use(assetRoutes)
    .use(userRoutes);

