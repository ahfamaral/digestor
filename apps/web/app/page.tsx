import { AppBar } from "@/components/AppBar";
import { UploadForm } from "@/components/UploadForm";

export default function UploadPage() {
  return (
    <>
      <AppBar current="Upload" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <h1 className="mb-1 text-xl font-bold tracking-tight">Digest a long video</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          Drop a video or paste a YouTube link — the language and the kind of event are detected for you.
        </p>
        <UploadForm />
      </main>
    </>
  );
}
