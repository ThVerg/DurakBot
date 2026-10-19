// The woodcut «ДУРАК» wordmark from the art kit (outlined lettering, lubok
// print: vermilion fill, cream outline, cobalt offset) with the jester's cap.
import { brandUrl } from "./art";

export function Wordmark({ className = "", cap = true }: { className?: string; cap?: boolean }) {
  return (
    <div className={`wordmark ${className}`} role="img" aria-label="ДУРАК">
      <img className="wordmark__img" src={brandUrl(cap ? "wordmark-ru" : "wordmark-ru-plain")} alt="" draggable={false} />
    </div>
  );
}

/** ДУРАК + cap + "— D U R A K —" flourish line (title hero). */
export function Lockup({ className = "" }: { className?: string }) {
  return (
    <div className={`lockup ${className}`} role="img" aria-label="ДУРАК · Durak">
      <img src={brandUrl("lockup")} alt="" draggable={false} />
    </div>
  );
}
