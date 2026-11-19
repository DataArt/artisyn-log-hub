import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import {
  fetchSystemStatus,
  workspaceKeys,
  type SystemStatus,
} from "../api/workspaces";
import { cn } from "../lib/cn";
import styles from "./DockerStatusGate.module.css";
import { TopBar } from "./TopBar";

/** How often the status is re-read while Docker or the image is not ready, and otherwise. */
const NOT_READY_POLL_MS = 5000;
const READY_POLL_MS = 30000;

function isReady(s: SystemStatus | undefined): boolean {
  return s == null || (s.docker === "ok" && s.defaultImage === "ok");
}

function FullPageMessage({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className={styles.page}>
      <TopBar />
      <div className={styles.body} data-testid="docker-status-gate">
        <div className={styles.message}>
          {icon}
          <p className={styles.title}>{title}</p>
          <p className={styles.text}>{text}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Shows a full-page message instead of `children` while Docker is unreachable or the default
 * container image is not ready (`GET /api/v1/system/status`), and re-checks on its own. A failed
 * status call itself does not block the page.
 */
export function DockerStatusGate({ children }: { children: ReactNode }) {
  const { data } = useQuery({
    queryKey: workspaceKeys.systemStatus,
    queryFn: fetchSystemStatus,
    refetchInterval: (q) =>
      isReady(q.state.data) ? READY_POLL_MS : NOT_READY_POLL_MS,
  });

  if (data?.docker === "unreachable") {
    return (
      <FullPageMessage
        icon={<CircleAlert className={cn(styles.icon, styles.iconError)} />}
        title="Work Hub can't reach Docker on this computer."
        text="Start Docker and try again. This page checks again on its own."
      />
    );
  }
  if (data?.defaultImage === "building") {
    return (
      <FullPageMessage
        icon={<Loader2 className={cn(styles.icon, styles.iconBusy)} />}
        title="Work Hub is preparing its container image…"
        text="This takes a few minutes the first time. The page opens on its own when it is ready."
      />
    );
  }
  if (data?.defaultImage === "failed") {
    return (
      <FullPageMessage
        icon={<CircleAlert className={cn(styles.icon, styles.iconError)} />}
        title="Work Hub couldn't prepare its container image."
        text="Check the Work Hub server log, then restart Work Hub to try again."
      />
    );
  }
  return <>{children}</>;
}
