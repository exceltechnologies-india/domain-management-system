import SkeletonBase from './SkeletonBase';

export default function SkeletonHero() {
  return (
    <div className="min-h-[60vh] sm:min-h-[70vh] flex items-center justify-center py-8 sm:py-12">
      <div className="w-full max-w-4xl px-4 text-center space-y-6">
        {/* Icon */}
        <div className="flex justify-center mb-4">
          <SkeletonBase className="h-16 w-16 rounded-full" />
        </div>
        
        {/* Title */}
        <SkeletonBase className="h-12 w-3/4 mx-auto" />
        
        {/* Subtitle */}
        <SkeletonBase className="h-6 w-2/3 mx-auto" />
        
        {/* Search box */}
        <div className="bg-white bg-opacity-10 backdrop-blur-md rounded-2xl p-4 max-w-4xl mx-auto">
          <SkeletonBase className="h-14 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}

