# Worklane for a single-port platform such as CranL (SPEC-3 §6): hosted
# mode on PORT behind the platform's HTTPS proxy. Configure it with
# MM_HOST_ORIGIN and MM_SITE_PASSWORD (see README.md, "Deploy privately on
# CranL"); without them the server explains what is missing and exits.
FROM node:22-alpine

ENV NODE_ENV=production
# Hosted mode listens on PORT; platforms that set PORT override this.
ENV PORT=8080

WORKDIR /app
# The default data file lives in /app/.data, so the app user owns /app.
RUN chown node:node /app
COPY --chown=node:node . .
USER node

EXPOSE 8080
CMD ["node", "server/main.js"]
