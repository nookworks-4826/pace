import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  HashRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  BarChart3,
  Check,
  Home as HomeIcon,
  List,
  Plus,
  Settings as SettingsIcon,
  WifiOff,
  X,
} from "lucide-react";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { useAppData } from "../hooks/useAppData";
import { computeFinance } from "../domain/finance";
import { todayJST } from "../domain/dates";
import { getLockConfig } from "../domain/security";
import { AppContext, usePace } from "./context";
import { Home } from "../features/Home";
import { History } from "../features/History";
import { Settings } from "../features/Settings";
import { Management } from "../features/Management";
import { ExpenseSheet } from "../features/ExpenseSheet";
import { Onboarding } from "../features/Onboarding";
import { LockScreen } from "../features/Security";
import { Timeline } from "../features/Timeline";
import { VaultGate } from "../features/VaultGate";
import { Money } from "../features/Money";
import { FinancialSettings } from "../features/FinancialSettings";
import { NotificationSettings } from "../features/NotificationSettings";
import { SalarySettings } from "../features/SalarySettings";
import { PrivacySettings } from "../features/PrivacySettings";
import { FinancialProviderError } from "../providers/types";
import { useFinancialConnections } from "../hooks/useFinancialConnections";
import { useFinancialReminder } from "../hooks/useFinancialReminder";
import { APP_NAME } from "../types";
import type { Expense } from "../types";
const Analytics = lazy(() =>
  import("../features/Analytics").then((m) => ({ default: m.Analytics })),
);

class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Financial data is never logged or transmitted. */
  }
  render() {
    return this.state.failed ? (
      <div className="fatal-error">
        <h1>画面を表示できませんでした</h1>
        <p>データは削除していません。アプリを開き直してください。</p>
        <button
          className="button button-primary"
          onClick={() => location.reload()}
        >
          開き直す
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function ScrollReset() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}
function AnalyticsRoute() {
  const { data } = usePace();
  const navigate = useNavigate();
  return (
    <Analytics
      data={data}
      onViewHistory={(category, month, from, to) =>
        navigate(
          `/history?${new URLSearchParams({ ...(category ? { category } : {}), ...(month ? { month } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}`,
        )
      }
    />
  );
}
function Application() {
  const { data, error } = useAppData();
  useFinancialConnections(data);
  useFinancialReminder(data);
  const [today, setToday] = useState(todayJST());
  const [expense, setExpense] = useState<Expense | true | null>(null);
  const [notice, setNotice] = useState<{
    message: string;
    undo?: () => Promise<void>;
  } | null>(null);
  const [noticeBusy, setNoticeBusy] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [lockError, setLockError] = useState("");
  const [locked, setLocked] = useState(() => {
    try {
      return getLockConfig().kind !== "none";
    } catch {
      return true;
    }
  });
  const [hidden, setHidden] = useState(document.hidden);
  const awayAt = useRef<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockTimeout = useRef(60);
  lockTimeout.current = data?.settings.lockAfterSeconds ?? 60;
  const appUpdate = useAppUpdate();
  const toast = useCallback((message: string, undo?: () => Promise<void>) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setNotice({ message, undo });
    toastTimer.current = setTimeout(() => setNotice(null), undo ? 12000 : 6000);
  }, []);
  const run = useCallback(
    async (action: () => Promise<void>, success?: string) => {
      try {
        await action();
        if (success) toast(success);
      } catch (e) {
        const message =
          e instanceof Error &&
          (e.name === "Error" || e instanceof FinancialProviderError)
            ? e.message
            : "操作を完了できませんでした。保存領域の空き容量を確認して、もう一度お試しください。";
        toast(message);
      }
    },
    [toast],
  );
  const openExpense = useCallback((e?: Expense) => setExpense(e ?? true), []);
  const closeExpense = useCallback(() => setExpense(null), []);
  useEffect(() => {
    const online = () => setOffline(!navigator.onLine);
    const time = () => setToday(todayJST());
    const config = () => {
      try {
        if (getLockConfig().kind === "none") setLocked(false);
        setLockError("");
      } catch (e) {
        setLockError(
          e instanceof Error ? e.message : "ロックを確認できません。",
        );
        setLocked(true);
      }
    };
    config();
    const visibility = () => {
      setHidden(document.hidden);
      time();
      if (document.hidden) {
        awayAt.current = Date.now();
        try {
          if (getLockConfig().kind !== "none" && lockTimeout.current === 0)
            setLocked(true);
        } catch {
          setLocked(true);
        }
      } else if (awayAt.current !== null) {
        try {
          if (
            getLockConfig().kind !== "none" &&
            Date.now() - awayAt.current >= lockTimeout.current * 1000
          )
            setLocked(true);
        } catch {
          setLocked(true);
        }
        awayAt.current = null;
      }
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    window.addEventListener("pace-lock-changed", config);
    document.addEventListener("visibilitychange", visibility);
    const interval = setInterval(time, 30000);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
      window.removeEventListener("pace-lock-changed", config);
      document.removeEventListener("visibilitychange", visibility);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!data) return;
    document.documentElement.dataset.theme = data.settings.theme;
    document.documentElement.dataset.mode = data.settings.colorMode;
  }, [data?.settings.theme, data?.settings.colorMode, data]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      document.documentElement.style.setProperty(
        "--visual-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
      document.documentElement.style.setProperty(
        "--keyboard-inset",
        `${Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0))}px`,
      );
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, []);
  const finance = useMemo(
    () => (data ? computeFinance(data, today) : null),
    [data, today],
  );
  if (locked || lockError)
    return (
      <LockScreen
        error={lockError || undefined}
        onUnlocked={() => {
          setLocked(false);
          awayAt.current = null;
        }}
      />
    );
  if (error)
    return (
      <div className="fatal-error">
        <h1>データを開けませんでした</h1>
        <p>{error}</p>
        <button
          className="button button-primary"
          onClick={() => location.reload()}
        >
          再試行
        </button>
      </div>
    );
  if (!data || !finance)
    return (
      <div className="boot-logo">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt={APP_NAME} />
      </div>
    );
  return (
    <AppContext.Provider
      value={{ data, finance, today, openExpense, toast, run, appUpdate }}
    >
      {hidden && (
        <div className="privacy-cover">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt={APP_NAME} />
        </div>
      )}
      {!data.settings.onboardingCompleted ? (
        <Onboarding />
      ) : (
        <div className="app-shell">
          <ScrollReset />
          {offline && (
            <div className="offline-banner">
              <WifiOff size={14} />
              オフライン · この端末に保存できます
            </div>
          )}
          {appUpdate.showBanner && (
            <div className="update-banner">
              <span>{APP_NAME}の更新があります</span>
              <button
                disabled={appUpdate.busy}
                onClick={() =>
                  void appUpdate.apply().then((message) => {
                    if (message) toast(message);
                  })
                }
              >
                {appUpdate.busy ? "更新中…" : "更新する"}
              </button>
              <button aria-label="更新を後で行う" onClick={appUpdate.dismiss}>
                <X size={16} />
              </button>
            </div>
          )}
          <Suspense
            fallback={
              <div
                className="skeleton-page"
                aria-label="画面を準備しています"
              />
            }
          >
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/history" element={<History />} />
              <Route path="/analytics" element={<AnalyticsRoute />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/money" element={<Money />} />
              <Route path="/financial" element={<FinancialSettings />} />
              <Route path="/notifications" element={<NotificationSettings />} />
              <Route path="/salary" element={<SalarySettings />} />
              <Route path="/privacy" element={<PrivacySettings />} />
              <Route path="/manage/:section" element={<Management />} />
              <Route path="/timeline" element={<Timeline />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
          <nav className="bottom-nav" aria-label="メインナビゲーション">
            <NavLink to="/" end>
              <HomeIcon size={22} />
              <span>ホーム</span>
            </NavLink>
            <NavLink to="/history">
              <List size={22} />
              <span>履歴</span>
            </NavLink>
            <button
              className="nav-add"
              aria-label="支出を追加"
              onClick={() => openExpense()}
            >
              <Plus size={29} />
            </button>
            <NavLink to="/analytics">
              <BarChart3 size={22} />
              <span>分析</span>
            </NavLink>
            <NavLink to="/settings">
              <SettingsIcon size={22} />
              <span>設定</span>
            </NavLink>
          </nav>
        </div>
      )}
      {expense && (
        <ExpenseSheet
          expense={expense === true ? undefined : expense}
          onClose={closeExpense}
        />
      )}{" "}
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{notice.message}</span>
          {notice.undo && (
            <button
              disabled={noticeBusy}
              onClick={() => {
                setNoticeBusy(true);
                void run(notice.undo!)
                  .then(() => {
                    setNotice(null);
                  })
                  .finally(() => setNoticeBusy(false));
              }}
            >
              元に戻す
            </button>
          )}
          <button
            className="toast-close"
            aria-label="通知を閉じる"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </AppContext.Provider>
  );
}
export function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <VaultGate>
          <Application />
        </VaultGate>
      </HashRouter>
    </ErrorBoundary>
  );
}
