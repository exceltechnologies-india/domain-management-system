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
    positive: 'text-green-600',
    negative: 'text-red-600',
    neutral: 'text-gray-600'
  };

  return (
    <div className={`bg-white rounded-lg shadow-sm p-6 border border-gray-200 ${className}`}>
      <div className="flex items-center">
        <div className="bg-primary-100 rounded-full p-3 mr-4">
          <Icon className="h-6 w-6 text-primary-600" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-600">{title}</p>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          {change && (
            <p className={`text-sm ${changeColors[change.type]}`}>
              {change.value}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
