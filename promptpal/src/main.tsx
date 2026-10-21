import React, { useEffect, useState, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Lazy load to prevent module side-effects (like DB file locks) from executing in the wrong window
const App = React.lazy(() => import("./App"));
const Companion = React.lazy(() => import("./Companion").then(m => ({ default: m.Companion })));

function RootRouter() {
  const [windowLabel, setWindowLabel] = useState<string | null>(null);

  useEffect(() => {
    // Determine which window this React instance is running in
    const current = getCurrentWindow();
    setWindowLabel(current.label);
  }, []);

  if (windowLabel === null) return null; // Wait for Tauri check

  return (
    <Suspense fallback={null}>
      {windowLabel === "companion" ? <Companion /> : <App />}
    </Suspense>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootRouter />
  </React.StrictMode>,
);