import SkeletonBase from './SkeletonBase';

interface SkeletonSectionProps {
  title?: boolean;
  cards?: number;
  columns?: 1 | 2 | 3 | 4;
}

export default function SkeletonSection({ 
  title = true, 
  cards = 3, 
  columns = 3 
}: SkeletonSectionProps) {
  const gridCols = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-4',
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-16">
      {title && (
        <div className="text-center mb-12">
          {/* Icon */}
          <div className="flex justify-center mb-4">
            <SkeletonBase className="h-12 w-12 rounded-full" />
          </div>
          
          {/* Title */}
          <SkeletonBase className="h-8 w-1/2 mx-auto mb-4" />
          
          {/* Description */}
          <div className="max-w-3xl mx-auto space-y-2">
            <SkeletonBase className="h-4 w-3/4 mx-auto" />
            <SkeletonBase className="h-4 w-2/3 mx-auto" />
          </div>
        </div>
      )}
      
      {/* Cards grid */}
      <div className={`grid ${gridCols[columns]} gap-6 sm:gap-8`}>
        {Array.from({ length: cards }).map((_, i) => (
          <div key={i} className="bg-white rounded-lg p-6 shadow-sm border border-gray-100">
            {/* Icon */}
            <div className="mb-4">
              <SkeletonBase className="h-10 w-10 rounded" />
            </div>
            
            {/* Title */}
            <SkeletonBase className="h-6 w-3/4 mb-3" />
            
            {/* Description */}
            <div className="space-y-2">
              <SkeletonBase className="h-4 w-full" />
              <SkeletonBase className="h-4 w-5/6" />
              <SkeletonBase className="h-4 w-4/6" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

