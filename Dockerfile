FROM oven/bun:1

WORKDIR /app

# ติดตั้ง dependencies ก่อน copy โค้ด เพื่อให้ Docker cache layer นี้ได้
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

# env (DB_HOST, PORT, ...) ส่งมาจาก docker-compose — ไม่ copy .env เข้า image
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
