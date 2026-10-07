import { readAppData } from "../db";
import { validateData } from "../domain/backup/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { checkServiceWorkerUpdate } from "../domain/appUpdate";

type Phase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "offline"
  | "unavailable"
  | "error"
  | "applying";
const messages: Record<Phase, string> = {
  idle: "現在の記録を保ったまま、アプリを更新できます。",
  checking: "更新を確認しています…",
  current: "この公開先で配信中の最新版です。",
  available: "新しいバージョンを利用できます。",
  offline: "通信できるときに更新を確認できます。記録はそのまま続けられます。",
  unavailable:
    "更新をまだ確認できません。公開したアプリで、少し待ってからお試しください。",
  error:
    "更新を確認・適用できませんでした。通信状態を確認して、もう一度お試しください。",
  applying: "更新を適用しています…",
};

export function useAppUpdate() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const [dismissed, setDismissed] = useState(false);
  const busy = useRef(false);
  const lastCheck = useRef(Date.now());
  const applyRequested = useRef(false);
  const reloadPending = useRef(false);
  const applyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const {
    needRefresh: [needRefresh],
  } = useRegisterSW({
    onRegisteredSW: (_url, value) => setRegistration(value),
    onRegisterError: () => {
      /* Keep local recording usable; a manual check explains failures. */
    },
    onNeedRefresh: () => {
      setPhase("available");
      setDismissed(false);
    },
    // Native controllerchange also covers updates initiated in other tabs.
    onNeedReload: () => {},
  });
  const available =
    needRefresh || phase === "available" || reloadPending.current;
  const check = useCallback(
    async (manual = true) => {
      if (busy.current) return;
      if (reloadPending.current) {
        setPhase("available");
        setDismissed(false);
        return;
      }
      if (!navigator.onLine) {
        if (manual) setPhase("offline");
        return;
      }
      if (!registration) {
        if (manual) setPhase("unavailable");
        return;
      }
      busy.current = true;
      lastCheck.current = Date.now();
      if (manual) setPhase("checking");
      try {
        const found = await checkServiceWorkerUpdate(registration);
        if (found) {
          setPhase("available");
          setDismissed(false);
        } else if (manual) setPhase("current");
      } catch {
        if (manual) setPhase("error");
      } finally {
        busy.current = false;
      }
    },
    [registration],
  );
  useEffect(() => {
    const checkWhenVisible = () => {
      if (!document.hidden && Date.now() - lastCheck.current >= 60 * 60 * 1000)
        void check(false);
    };
    const timer = setInterval(checkWhenVisible, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", checkWhenVisible);
    window.addEventListener("online", checkWhenVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", checkWhenVisible);
      window.removeEventListener("online", checkWhenVisible);
    };
  }, [check]);
  useEffect(() => () => clearTimeout(applyTimer.current), []);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let previous = navigator.serviceWorker.controller;
    const controlled = () => {
      const current = navigator.serviceWorker.controller;
      const changed =
        previous !== null && current !== null && previous !== current;
      previous = current;
      if (!changed) return;
      clearTimeout(applyTimer.current);
      busy.current = false;
      if (
        applyRequested.current &&
        !document.querySelector('[role="dialog"]')
      ) {
        window.location.reload();
      } else {
        // Preserve this tab's form until its user explicitly applies the update.
        applyRequested.current = false;
        reloadPending.current = true;
        setPhase("available");
        setDismissed(false);
      }
    };
    navigator.serviceWorker.addEventListener("controllerchange", controlled);
    return () =>
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        controlled,
      );
  }, []);
  const apply = async () => {
    if (busy.current) return;
    if (document.querySelector('[role="dialog"]'))
      return "入力・設定画面を保存して閉じてから、更新してください。";
    try {
      validateData(await readAppData());
    } catch {
      return "記録の確認を完了できませんでした。更新せず、バックアップを確認してください。";
    }
    if (
      !confirm(
        "更新前にバックアップの保存先を確認してください。更新を続けますか？",
      )
    )
      return;
    if (reloadPending.current) {
      window.location.reload();
      return;
    }
    if (!registration?.waiting) {
      await check();
      return;
    }
    busy.current = true;
    applyRequested.current = true;
    setPhase("applying");
    applyTimer.current = setTimeout(() => {
      busy.current = false;
      applyRequested.current = false;
      setPhase("error");
    }, 10000);
    try {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    } catch {
      clearTimeout(applyTimer.current);
      busy.current = false;
      applyRequested.current = false;
      setPhase("error");
    }
  };
  return {
    available,
    showBanner: available && !dismissed,
    busy: phase === "checking" || phase === "applying",
    message: messages[phase === "idle" && available ? "available" : phase],
    check: () => check(true),
    apply,
    dismiss: () => setDismissed(true),
  };
}
