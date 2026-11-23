import type { Metadata } from "next";
import { pageTitle } from "@/lib/pageTitle";
import { AppBar } from "@/components/AppBar";
import { UploadForm } from "@/components/UploadForm";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: pageTitle(t("upload.title")) };

export default function NewVideoPage() {
  return (
    <>
      <AppBar current="Upload" />
      <main id="content" tabIndex={-1} className="outline-none mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <h1 className="mb-1 text-xl font-bold tracking-tight">{t("upload.title")}</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          {t("upload.intro")}
        </p>
        <UploadForm />
      </main>
    </>
  );
}
