import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { GlobalAudioProvider } from "./audio/GlobalAudioContext";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <GlobalAudioProvider>
      <App />
    </GlobalAudioProvider>
  </React.StrictMode>,
);
