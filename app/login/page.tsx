"use client";

import { Suspense, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function LoginForm() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(false);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (res.ok) {
      const next = new URLSearchParams(window.location.search).get("next") || "/";
      window.location.href = next.startsWith("/") ? next : "/";
    } else {
      setErr(true);
      setLoading(false);
      setPw("");
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="p-7">
          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="mb-1 flex items-center gap-2">
              <Lock className="size-5 text-primary" />
              <h1 className="text-2xl font-bold tracking-tight">
                job<span className="text-primary">now</span>
              </h1>
            </div>
            <p className="text-[13px] text-muted-foreground">Enter the password to continue.</p>
            <Input
              type="password"
              autoFocus
              placeholder="Password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              className={err ? "h-11 border-destructive text-base" : "h-11 text-base"}
            />
            {err && <div className="text-[13px] text-destructive">Wrong password — try again.</div>}
            <Button type="submit" size="lg" disabled={loading || !pw} className="mt-1">
              {loading ? "Checking…" : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
