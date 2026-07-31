import { Elysia } from "elysia";
import { eventStream } from "./events.service";

export const eventsRoutes = new Elysia({ prefix: "/events" }).get("/", ({ request }) =>
  eventStream(request.signal),
);
