import { motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { Card } from "../ui/card";

export default function ReadinessTile({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      layout
      animate={reduceMotion ? undefined : { opacity: 1 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
    >
      <Card className="p-3 shadow-none">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p>
          {ok ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : (
            <CircleAlert className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <p className="mt-2 text-sm font-medium">{value}</p>
      </Card>
    </motion.div>
  );
}
