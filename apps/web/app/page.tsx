import { Suspense } from "react";
import { AppBar } from "@/components/AppBar";
import { UploadForm } from "@/components/UploadForm";
import { SessionList } from "@/components/SessionList";
import { t } from "@/lib/i18n";

export default function UploadPage() {
  return (
    <>
      <AppBar current="Upload" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <h1 className="mb-1 text-xl font-bold tracking-tight">{t("upload.title")}</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          {t("upload.intro")}
        </p>
        <UploadForm />
        <Suspense fallback={null}>
          <SessionList />
        </Suspense>
      </main>
    </>
  );
}
