FROM node:22-slim
WORKDIR /app
COPY . .
ENV PORT=3000
# Mount a volume at /data and pass a fixed TOOL_TOKEN, or redeploys lose leads and break the agent's tools.
ENV DB_PATH=/data/propreach.db
EXPOSE 3000
CMD ["npm", "start"]
