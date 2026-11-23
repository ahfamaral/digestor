import type { Metadata } from "next";
import { pageTitle } from "@/lib/pageTitle";
import { t } from "@/lib/i18n";
import { AppBar } from "@/components/AppBar";
import { LoginForm } from "@/components/LoginForm";

export const metadata: Metadata = { title: pageTitle(t("login.title")) };

export default function LoginPage() {
  return (
    <>
      <AppBar signedOut />
      <main id="content" tabIndex={-1} className="outline-none flex flex-1 items-start justify-center px-4 py-16">
        <LoginForm />
      </main>
    </>
  );
}
