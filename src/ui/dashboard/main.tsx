import { createRoot } from "react-dom/client";
import { Dashboard } from "./Dashboard";
import "../shared/styles.css";
import { DialogProvider } from "../shared/dialog";

createRoot(document.getElementById("root")!).render(
  <DialogProvider>
    <Dashboard />
  </DialogProvider>,
);
