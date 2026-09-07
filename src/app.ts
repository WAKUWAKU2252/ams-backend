import { Elysia } from "elysia";
import { setup } from "./plugins/setup";
import { authRoutes } from "./modules/shared/auth";
import { purchaseOrderRoutes } from "./modules/business/purchase-order";
import { assetRequestRoutes } from "./modules/business/asset-request";
import { uploadRoutes, uploadPublicRoutes } from "./modules/shared/upload";
import { grpoRoutes } from "./modules/business/grpo";
import { assetRoutes, assetPublicRoutes } from "./modules/business/asset";
import { userRoutes } from "./modules/shared/user";
import { syncRoutes } from "./modules/integrate/SAP";
import { masterRoutes, masterPublicRoutes } from "./modules/business/master";
import { dashboardRoutes } from "./modules/business/dashboard";
import { teamsRoutes } from "./modules/integrate/TEAMS/teams.routes";

// ประกอบ app ทั้งหมด — แยกจาก listen() เพื่อให้ test เรียก createApp().handle(...) ได้
export const createApp = () =>
  new Elysia()
    .use(setup)
    .get("/health", () => ({ status: "ok" }))
    .use(authRoutes)
    .use(masterPublicRoutes)
    .use(masterRoutes)
    .use(dashboardRoutes)
    .use(purchaseOrderRoutes)
    .use(assetRequestRoutes)
    .use(uploadPublicRoutes)
    .use(uploadRoutes)
    .use(grpoRoutes)
    .use(assetPublicRoutes)
    .use(assetRoutes)
    .use(userRoutes)
    .use(syncRoutes)
    .use(teamsRoutes)
    ;
