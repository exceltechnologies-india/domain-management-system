import { cn } from '@/lib/utils';

interface SkeletonBaseProps {
  className?: string;
  animate?: boolean;
}

export default function SkeletonBase({ className, animate = true }: SkeletonBaseProps) {
  return (
    <div
      className={cn(
        'bg-gray-200 rounded',
        animate && 'animate-pulse',
        className
      )}
    />
  );
}

