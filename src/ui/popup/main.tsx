import { createRoot } from "react-dom/client";
import { Popup } from "./Popup";
import "../shared/styles.css";
import { DialogProvider } from "../shared/dialog";

createRoot(document.getElementById("root")!).render(
  <DialogProvider>
    <Popup />
  </DialogProvider>,
);
