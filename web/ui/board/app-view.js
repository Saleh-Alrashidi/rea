/**
 * App board view: a sandboxed iframe at the view's `app_url`, connected to
 * the host through `createHostBridge` (exact app origin, exact iframe
 * window). The host supplies context, in-memory settings per install,
 * session tokens, notices, item navigation, confirmations, safe link
 * opening, app-scoped GraphQL and forwarded board events.
 */

import { graphql, requestSessionToken } from "../../api.js";
import { clear, h } from "../../dom.js";
import { createHostBridge } from "../../host-bridge.js";
import { confirmDialog } from "../components/dialog.js";
import { emptyState } from "../components/empty-state.js";
import { showToast } from "../components/toast.js";

const SANDBOX = "allow-scripts allow-same-origin allow-forms";
const MAX_SETTINGS_LENGTH = 65_536;
/** App settings live in memory, per install, for the page's lifetime. */
const settingsByInstall = new Map();

function parseAppUrl(appUrl) {
  if (typeof appUrl !== "string") return null;
  try {
    const url = new URL(appUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function unavailable(container, message) {
  clear(container).append(
    emptyState({
      icon: "app",
      title: "This app view is unavailable",
      text: message,
    }),
  );
  return { emit: () => false, destroy() {} };
}

function settingsHandlers(installId, getBridge) {
  return {
    getSettings: () => structuredClone(settingsByInstall.get(installId) ?? {}),
    async setSettings(value) {
      // Bound what an app can make the host retain.
      if (JSON.stringify(value).length > MAX_SETTINGS_LENGTH) {
        throw new Error("App settings are too large");
      }
      settingsByInstall.set(installId, structuredClone(value));
      getBridge()?.emit("settings", structuredClone(value));
      return structuredClone(value);
    },
  };
}

function createHandlers({ view, installId, host, getBridge }) {
  return {
    getContext: () => host.getContext(view),
    ...settingsHandlers(installId, getBridge),
    getSessionToken: () => requestSessionToken(installId),
    getLocation: () => ({ href: globalThis.location.href }),
    getFilter: () => host.getFilter(),
    getItemIds: async () => host.getItemIds(),
    notice({ message, type, timeout }) {
      showToast({ message, type, timeout, source: view.name });
    },
    openItemCard: ({ itemId }) => host.openItem(itemId),
    confirm: ({ message, confirmButton, cancelButton }) =>
      confirmDialog({
        title: `${view.name} asks`,
        message,
        confirmButton,
        cancelButton,
        source: view.name,
      }),
    openLinkInTab({ url }) {
      // The bridge already accepted only http: and https: URLs.
      globalThis.open(url, "_blank", "noopener,noreferrer");
    },
    graphql: ({ query, variables, operationName }) =>
      graphql(query, variables, { installId, operationName }),
  };
}

/**
 * Mounts the app iframe for `view` into `container`.
 * `host` provides `getContext(view)`, `getFilter()`, `getItemIds()` and
 * `openItem(itemId)`.
 *
 * @param {HTMLElement} container
 * @param {{ view: object, host: object }} options
 * @returns {{ emit(type: string, data: unknown): boolean, destroy(): void }}
 */
export function mountAppView(container, { view, host }) {
  const url = parseAppUrl(view.app_url);
  if (!url || !view.app_install_id) {
    return unavailable(container, "The app's address is missing or invalid.");
  }
  const installId = String(view.app_install_id);
  const iframe = h("iframe", {
    class: "app-frame",
    title: `${view.name} app`,
    src: url.href,
    sandbox: SANDBOX,
    referrerpolicy: "no-referrer",
  });
  const wrapper = h("div", { class: "app-view" }, iframe);
  clear(container).append(wrapper);
  let bridge = null;
  const handlers = createHandlers({
    view,
    installId,
    host,
    getBridge: () => bridge,
  });
  bridge = createHostBridge({ iframe, appOrigin: url.origin, handlers });
  return {
    emit: (type, data) => bridge.emit(type, data),
    destroy() {
      bridge.destroy();
      wrapper.remove();
    },
  };
}
