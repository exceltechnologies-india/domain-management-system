import { LucideIcon } from 'lucide-react';

interface AdminCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  change?: {
    value: string;
    type: 'positive' | 'negative' | 'neutral';
  };
  className?: string;
}

export default function AdminCard({
  title,
  value,
  icon: Icon,
  change,
  className = ''
}: AdminCardProps) {
  const changeColors = {
    positive: 'text-emerald-700',
    negative: 'text-rose-700',
    neutral: 'text-ink-3'
  };

  return (
    <div className={`bg-paper rounded-lg border border-hairline shadow-[0_1px_2px_rgba(0,0,0,0.04)] p-6 ${className}`}>
      <div className="flex items-center">
        <div className="bg-amber-soft rounded-md p-3 mr-4">
          <Icon className="h-6 w-6 text-amber" />
        </div>
        <div className="flex-1">
          <p className="text-sm text-ink-3">{title}</p>
          <p className="text-2xl font-semibold tabular-nums text-ink">{value}</p>
          {change && (
            <p className={`text-sm mt-0.5 ${changeColors[change.type]}`}>
              {change.value}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
