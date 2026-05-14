import SkeletonBase from './SkeletonBase';

export default function SkeletonCard() {
  return (
    <div className="bg-white rounded-lg p-6 shadow-sm border border-gray-100">
      {/* Icon circle */}
      <div className="flex justify-center mb-4">
        <SkeletonBase className="h-16 w-16 rounded-full" />
      </div>
      
      {/* Title */}
      <SkeletonBase className="h-6 w-3/4 mx-auto mb-3" />
      
      {/* Description lines */}
      <div className="space-y-2">
        <SkeletonBase className="h-4 w-full" />
        <SkeletonBase className="h-4 w-5/6 mx-auto" />
        <SkeletonBase className="h-4 w-4/6 mx-auto" />
      </div>
    </div>
  );
}

