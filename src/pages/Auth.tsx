import { useEffect, useState } from "react";
import { supabase } from "../../services/supabase";

export default function Auth() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<string>("");
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);

  useEffect(() => {
  supabase.auth.getSession().then(({ data }) => {
    setSessionEmail(data.session?.user.email ?? null);
  });

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    setSessionEmail(session?.user.email ?? null);
    if (session?.user?.email) setStatus(`Logged in as ${session.user.email}`);
    if (!session) setStatus("Logged out.");
  });

  return () => subscription.unsubscribe();
}, []);


  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setStatus("");

    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setStatus("Check your email to confirm your account (if confirmations are enabled).");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setStatus("Logged in.");
      }
    } catch (err: any) {
      setStatus(err?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function onLogout() {
    setLoading(true);
    setStatus("");
    const { error } = await supabase.auth.signOut();
    if (error) setStatus(error.message);
    else setStatus("Logged out.");
    setLoading(false);
  }

  return (
    <div style={{ maxWidth: 420, margin: "40px auto", padding: 16 }}>
      <h1 style={{ marginBottom: 12 }}>Account</h1>
      {sessionEmail ? (
  <div style={{ marginBottom: 12 }}>
    <p style={{ margin: 0 }}>Logged in as {sessionEmail}</p>
    <button
      type="button"
      onClick={onLogout}
      disabled={loading}
      style={{ padding: 10, marginTop: 10 }}
    >
      Log out
    </button>
  </div>
) : null}

{!sessionEmail ? (
<>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => setMode("login")}
          disabled={loading}
          style={{ flex: 1, padding: 10, opacity: mode === "login" ? 1 : 0.6 }}
        >
          Log in
        </button>
        <button
          type="button"
          onClick={() => setMode("signup")}
          disabled={loading}
          style={{ flex: 1, padding: 10, opacity: mode === "signup" ? 1 : 0.6 }}
        >
          Sign up
        </button>
      </div>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 10 }}>
        <label style={{ display: "grid", gap: 6 }}>
          Email
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            required
            disabled={loading}
            style={{ padding: 10 }}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          Password
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            required
            disabled={loading}
            style={{ padding: 10 }}
          />
        </label>

        <button type="submit" disabled={loading} style={{ padding: 10 }}>
          {loading ? "Working..." : mode === "signup" ? "Create account" : "Log in"}
        </button>
      </form>
      </>

      ) : null}


      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={onLogout} disabled={loading} style={{ padding: 10 }}>
          Log out
        </button>
      </div>

      {status ? (
        <p style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{status}</p>
      ) : null}
    </div>
  );
}
