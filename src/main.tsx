import ReactDOM from "react-dom/client";
import App from "./ui/App";
import "./ui/tokens.css";
import "./ui/app.css";
import "./ui/surfaces.css";

if (import.meta.env.DEV) {
  import("./devhook").then((m) => m.installDevHook());
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />
);
