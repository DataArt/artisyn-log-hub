import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "../lib/cn";
import styles from "./toast.module.css";

/** How long a toast stays up (D16). */
export const TOAST_DURATION_MS = 4000;

export type ToastTone = "info" | "success" | "error";

interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

interface ToastContextValue {
  show: (text: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_CLASS: Record<ToastTone, string> = {
  info: styles.toneInfo,
  success: styles.toneSuccess,
  error: styles.toneError,
};

function ToneIcon({ tone }: { tone: ToastTone }) {
  if (tone === "success") return <CircleCheck className={styles.icon} />;
  if (tone === "error") return <CircleAlert className={styles.icon} />;
  return <Info className={cn(styles.icon, styles.iconInfo)} />;
}

/** A minimal toast stack, bottom right, each toast hidden after {@link TOAST_DURATION_MS}. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((list) => list.filter((i) => i.id !== id));
  }, []);

  const show = useCallback(
    (text: string, tone: ToastTone = "info") => {
      const id = nextId.current++;
      setItems((list) => [...list, { id, text, tone }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_DURATION_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.stack} aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            data-testid="toast"
            data-tone={item.tone}
            className={cn(styles.toast, TONE_CLASS[item.tone])}
          >
            <ToneIcon tone={item.tone} />
            <span className={styles.text}>{item.text}</span>
            <button
              type="button"
              className={styles.dismiss}
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss"
            >
              <X className={styles.dismissIcon} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
