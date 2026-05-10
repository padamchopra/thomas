import { cn } from "../lib/utils";

export function Button({ className, variant = "default", size = "default", as: Component = "button", ...props }) {
  return (
    <Component
      className={cn("ui-button", `ui-button-${variant}`, `ui-button-${size}`, className)}
      {...props}
    />
  );
}

export function Card({ className, as: Component = "div", ...props }) {
  return <Component className={cn("ui-card", className)} {...props} />;
}

export function CardHeader({ className, ...props }) {
  return <div className={cn("ui-card-header", className)} {...props} />;
}

export function CardTitle({ className, as: Component = "h2", ...props }) {
  return <Component className={cn("ui-card-title", className)} {...props} />;
}

export function CardDescription({ className, ...props }) {
  return <p className={cn("ui-card-description", className)} {...props} />;
}

export function CardContent({ className, ...props }) {
  return <div className={cn("ui-card-content", className)} {...props} />;
}

export function Badge({ className, variant = "secondary", ...props }) {
  return <span className={cn("ui-badge", `ui-badge-${variant}`, className)} {...props} />;
}

export function Input({ className, ...props }) {
  return <input className={cn("ui-input", className)} {...props} />;
}

export function Textarea({ className, ...props }) {
  return <textarea className={cn("ui-textarea", className)} {...props} />;
}

export function Select({ className, ...props }) {
  return <select className={cn("ui-select", className)} {...props} />;
}
