import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { consumeOAuthCallback } from "./providers/moneytree/pkce";
import "./styles/app.css";
import "./styles/refresh.css";
import "./styles/automation.css";
import "./styles/experience.css";
// Discard old authorization responses before rendering. Bank connections are not enabled.
consumeOAuthCallback(location.href, (url) =>
  history.replaceState(null, "", url),
);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
