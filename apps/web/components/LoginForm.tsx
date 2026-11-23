"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { Busy } from "@/components/ui/spinner";

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace("/");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? t("login.errorGeneric"));
    } catch {
      setError(t("login.errorNetwork"));
    }
    setPending(false);
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <h1 data-slot="card-title" className="font-heading text-base leading-snug font-medium">{t("login.title")}</h1>
        <CardDescription>{t("login.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label htmlFor="login-password" className="-mb-1.5 text-sm font-medium">{t("login.password")}</label>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            aria-invalid={error !== null}
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="h-9 bg-brand text-brand-foreground hover:brightness-90 active:brightness-[0.82]" disabled={pending || !password}>
            <Busy busy={pending}>{pending ? t("login.checking") : t("login.continue")}</Busy>
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
