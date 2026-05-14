import SkeletonBase from './SkeletonBase';

export default function SkeletonStats() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-8">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="bg-white rounded-lg p-6 shadow-sm border border-gray-100">
          {/* Icon */}
          <SkeletonBase className="h-8 w-8 mb-3 rounded" />
          
          {/* Value */}
          <SkeletonBase className="h-8 w-24 mb-2" />
          
          {/* Label */}
          <SkeletonBase className="h-4 w-20" />
          
          {/* Trend */}
          <SkeletonBase className="h-3 w-16 mt-2" />
        </div>
      ))}
    </div>
  );
}

