import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import App, { type Portal } from "./App";
import { api } from "./lib/api";
import { applySession, loadAppConfig, onUnauthorized, supabase, type AppConfig } from "./lib/auth";
import { Card, Spinner } from "./components/ui";
import { ThemeToggle } from "./components/theme-toggle";
import { Icon } from "./components/icons";
import { isPortalId, landingPortal, PORTALS, portalsFor, type PortalDef } from "./portals";

/**
 * What happens before the dashboard.
 *
 * The order is: choose a portal, then sign in, then work. Choosing first is deliberate —
 * the two portals answer different questions ("what is happening today" versus "will this
 * project land"), and a person usually opens the page already knowing which one they came
 * for. Being asked that before being asked for a password also means the sign-in screen
 * can say what you are signing in to.
 *
 * ── One account, both portals ───────────────────────────────────────────────
 * The picker chooses WHERE YOU LAND. It is not a security boundary and does not gate
 * anything: the same credentials open both, and what a person may see or do is decided by
 * their role and by row-level security in Postgres, exactly as before. The UI says so
 * rather than implying two separate logins, because implying a boundary that does not
 * exist is worse than having no boundary at all.
 *
 * A session that already exists is not re-challenged. Asking again for a password the
 * browser is already holding is theatre, not security.
 */

type Auth =
  | { kind: "loading" }
  | { kind: "demo" }
  | { kind: "error"; message: string; cfg: AppConfig | null }
  | { kind: "signedOut"; cfg: AppConfig }
  | { kind: "ready"; cfg: AppConfig; name: string; isCeo: boolean; capabilities: string[] | null };

const PORTAL_KEY = "fn.portal";

/** The portal from the URL, else the one chosen last time, else none (show the picker). */
function initialPortal(): Portal | null {
  const head = location.hash.slice(1).split("/", 1)[0];
  if (isPortalId(head)) return head;
  // A machine sticker's link (#visit/<token>) opens the Route portal, which offers that machine's visit.
  if (head === "visit") return "route";
  try {
    const v = sessionStorage.getItem(PORTAL_KEY);
    if (isPortalId(v)) return v;
  } catch {
    /* private mode — the picker is a fine place to start */
  }
  return null;
}

export default function Root() {
  const [auth, setAuth] = useState<Auth>({ kind: "loading" });
  const [portal, setPortal] = useState<Portal | null>(() => initialPortal());

  const choosePortal = useCallback((p: Portal | null) => {
    try {
      if (p) sessionStorage.setItem(PORTAL_KEY, p);
      else sessionStorage.removeItem(PORTAL_KEY);
    } catch {
      /* the choice still applies for this page load */
    }
    if (!p) history.replaceState(null, "", location.pathname + location.search);
    setPortal(p);
  }, []);

  const resolve = useCallback(async (cfg: AppConfig, session: Session | null) => {
    applySession(session);
    if (!session) {
      setAuth({ kind: "signedOut", cfg });
      return;
    }
    try {
      const me = await api.me();
      setAuth({ kind: "ready", cfg, name: me.displayName ?? "Signed in", isCeo: me.isCeo, capabilities: me.capabilities ?? null });
    } catch (e) {
      setAuth({ kind: "error", cfg, message: e instanceof Error ? e.message : "Could not load your account" });
    }
  }, []);

  useEffect(() => {
    // `cancelled` matters because the subscription is set up AFTER an await: under React
    // StrictMode (and on any unmount during a slow /app-config) the cleanup below runs
    // while `unsubscribe` is still undefined, leaking the listener and double-firing
    // `resolve` on every later auth event.
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const cfg = await loadAppConfig();
        if (cancelled) return;
        if (!cfg.authRequired) {
          setAuth({ kind: "demo" });
          return;
        }
        const sb = supabase(cfg);
        // onAuthStateChange fires INITIAL_SESSION straight away, so it covers both the
        // restored session on page load and every later sign-in, refresh and sign-out.
        const { data } = sb.auth.onAuthStateChange((_event, session) => {
          if (!cancelled) void resolve(cfg, session);
        });
        // Unmounted while we were awaiting: tear the listener down immediately rather
        // than handing it to a cleanup that has already run.
        if (cancelled) {
          data.subscription.unsubscribe();
          return;
        }
        unsubscribe = () => data.subscription.unsubscribe();
        onUnauthorized(() => {
          void sb.auth.signOut();
        });
      } catch (e) {
        if (!cancelled) {
          setAuth({ kind: "error", cfg: null, message: e instanceof Error ? e.message : "Could not start" });
        }
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [resolve]);

  if (auth.kind === "loading") {
    return (
      <div className="grid min-h-full place-items-center">
        <Spinner label="Starting…" />
      </div>
    );
  }

  if (auth.kind === "error") {
    return (
      <Entry isDemo={auth.cfg?.isDemo ?? false}>
        <Card className="w-full max-w-md">
          <h1 className="mb-2 text-base font-semibold">FreshNow Operations</h1>
          <p className="text-sm text-crit">{auth.message}</p>
          {auth.cfg ? (
            <button
              onClick={() => void supabase(auth.cfg!).auth.signOut()}
              className="mt-3 rounded-lg border border-edge bg-sunken px-3 py-2 text-sm hover:border-link"
            >
              Sign out and use another account
            </button>
          ) : null}
        </Card>
      </Entry>
    );
  }

  // 1 — Which portal? Asked first, in every mode.
  if (!portal) {
    return (
      <PortalPicker
        // Signed in, the picker offers what this person's role opens; before that nobody is known
        // yet, so it shows every portal (choosing one is not access — the API decides that).
        portals={auth.kind === "ready" && auth.capabilities ? portalsFor(auth.capabilities) : [...PORTALS]}
        onPick={choosePortal}
        signedIn={auth.kind === "ready"}
        isDemo={auth.kind === "demo" ? true : auth.kind === "ready" || auth.kind === "signedOut" ? auth.cfg.isDemo : false}
      />
    );
  }

  // 2 — Who are you? Only when sign-in is on and there is no session yet.
  if (auth.kind === "signedOut") {
    return <Login cfg={auth.cfg} portal={portal} onBack={() => choosePortal(null)} />;
  }

  // 3 — Work.
  return (
    <App
      // Signed in, a portal this person's role does not open is never even mounted.
      initialPortal={auth.kind === "ready" && auth.capabilities ? landingPortal(portal, auth.capabilities) : portal}
      onPortalChange={choosePortal}
      isDemo={auth.kind === "demo" ? true : auth.cfg.isDemo}
      {...(auth.kind === "ready"
        ? {
            identity: {
              name: auth.name,
              isCeo: auth.isCeo,
              onSignOut: () => {
                choosePortal(null); // sign-out returns to the picker, not to a blank login
                void supabase(auth.cfg).auth.signOut();
              },
            },
          }
        : {})}
    />
  );
}

/**
 * The centred frame the pre-dashboard screens share, with the theme control always
 * reachable. The DEMO badge is shown only when the API says this build really is serving
 * synthetic data — it used to be hardcoded, which would have kept claiming DEMO over real
 * company records.
 */
function Entry({ children, isDemo = false }: { children: React.ReactNode; isDemo?: boolean }) {
  return (
    <div className="min-h-full">
      {/* The brand's own green, the full width of the page — the first thing anyone sees. */}
      <div className="h-1.5 w-full" style={{ background: "linear-gradient(90deg, var(--color-brand-2), var(--color-brand) 55%, var(--color-accent))" }} />
      <div className="mx-auto flex max-w-5xl items-center gap-2.5 px-4 py-3">
        <span className="grid h-9 w-9 place-items-center rounded-xl text-on-brand shadow" style={{ background: "linear-gradient(135deg, var(--color-brand), var(--color-brand-b))" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v4M12 17v4M3 12h4M17 12h4M12 8l1.5 2.5L16 12l-2.5 1.5L12 16l-1.5-2.5L8 12l2.5-1.5Z" />
          </svg>
        </span>
        <h1 className="text-base font-bold leading-tight">
          FreshNow<span className="block text-[11px] font-medium text-mut">Operations</span>
        </h1>
        {isDemo ? (
          <span className="rounded bg-warn px-2 py-0.5 text-[11px] font-bold text-on-accent">DEMO</span>
        ) : null}
        <div className="flex-1" />
        <ThemeToggle />
      </div>
      <div className="grid place-items-center px-4 pb-16 pt-6">{children}</div>
    </div>
  );
}

function PortalPicker({
  portals,
  onPick,
  signedIn,
  isDemo,
}: {
  portals: PortalDef[];
  onPick: (p: Portal) => void;
  signedIn: boolean;
  isDemo: boolean;
}) {
  return (
    <Entry isDemo={isDemo}>
      <div className="w-full max-w-4xl">
        <div className="mb-5 text-center">
          <h2 className="text-2xl font-bold tracking-tight">Where are you working today?</h2>
          <p className="mt-1 text-sm text-mut">
            {signedIn
              ? "You are already signed in — pick one to carry on."
              : "Pick one, then sign in. One account opens every portal your role includes, and you can switch at any time."}
          </p>
        </div>
        <div className={`grid gap-4 sm:grid-cols-2 ${portals.length > 2 ? "lg:grid-cols-3" : ""}`}>
          {portals.map((p) => {
            const I = Icon[p.icon];
            const fill = p.id === "tasks" ? "var(--color-brand)" : "var(--color-accent)";
            return (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
              className="group relative overflow-hidden rounded-2xl border border-edge bg-panel p-5 text-left transition hover:-translate-y-0.5 hover:border-ok hover:shadow-lg focus:border-ok focus:outline-none"
            >
              {/* A brand stripe down the left edge, filled on hover. */}
              <span className="absolute inset-y-0 left-0 w-1.5" style={{ background: p.id === "tasks" ? "linear-gradient(180deg, var(--color-brand), var(--color-brand-b))" : "linear-gradient(180deg, var(--color-accent), var(--color-brand-2))" }} />
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-on-brand" style={{ background: fill }} aria-hidden="true">
                  <I size={22} />
                </span>
                <span className="text-base font-bold">{p.name}</span>
              </div>
              <p className="mt-1 text-sm text-mut">{p.tagline}</p>
              <ul className="mt-3 space-y-1 text-xs text-mut">
                {p.points.map((pt) => (
                  <li key={pt} className="flex gap-1.5">
                    <span className="text-ok" aria-hidden="true">·</span>
                    <span>{pt}</span>
                  </li>
                ))}
              </ul>
              <span className="mt-4 inline-block text-sm font-semibold text-ok group-hover:underline">
                {signedIn ? "Open" : "Continue"} →
              </span>
            </button>
            );
          })}
        </div>
      </div>
    </Entry>
  );
}

function Login({ cfg, portal, onBack }: { cfg: AppConfig; portal: Portal; onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const chosen = PORTALS.find((p) => p.id === portal) ?? PORTALS[0]!;
  const ChosenIcon = Icon[chosen.icon];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase(cfg).auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    // Success needs no handling here: onAuthStateChange in Root picks up the new session.
    if (error) {
      setErr(
        error.message === "Invalid login credentials"
          ? "That email and password do not match an account."
          : error.message,
      );
    }
  }

  return (
    <Entry isDemo={cfg.isDemo}>
      <Card className="w-full max-w-sm">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <span className="text-mut" aria-hidden="true"><ChosenIcon size={18} /></span>
          <span className="font-semibold">{chosen.name}</span>
        </div>
        <p className="mb-4 text-xs text-mut">
          Sign in to continue. One account opens every portal your role includes — what you can see and do is set by your role.
        </p>
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <label className="block text-sm">
            <span className="text-mut">Email</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-edge bg-sunken px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="text-mut">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-edge bg-sunken px-3 py-2"
            />
          </label>
          {err ? <p className="text-sm text-crit">{err}</p> : null}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg border border-ok bg-ok/10 px-3 py-2 text-sm font-semibold text-ok disabled:opacity-50"
          >
            {busy ? "Signing in…" : `Sign in to ${chosen.name}`}
          </button>
        </form>
        <button onClick={onBack} className="mt-3 text-xs text-mut hover:text-link hover:underline">
          ← Choose a different portal
        </button>
      </Card>
    </Entry>
  );
}
