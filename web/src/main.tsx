import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./dacha/ds.css";
import "./dacha/title.css";
import "./dacha/lobby.css";
import "./dacha/table/table.css";
import "./dacha/screens.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
