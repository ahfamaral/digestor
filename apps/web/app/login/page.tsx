import { AppBar } from "@/components/AppBar";
import { LoginForm } from "@/components/LoginForm";

export default function LoginPage() {
  return (
    <>
      <AppBar signedOut />
      <main className="flex flex-1 items-start justify-center px-4 py-16">
        <LoginForm />
      </main>
    </>
  );
}
