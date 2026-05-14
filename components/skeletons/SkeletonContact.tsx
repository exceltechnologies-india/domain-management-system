import SkeletonBase from './SkeletonBase';

export default function SkeletonContact() {
  return (
    <div className="grid md:grid-cols-2 gap-8 lg:gap-12">
      {/* Contact Form */}
      <div className="space-y-6">
        {/* Form fields */}
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <SkeletonBase className="h-4 w-24 mb-2" />
            <SkeletonBase className="h-12 w-full rounded-lg" />
          </div>
        ))}
        
        {/* Submit button */}
        <SkeletonBase className="h-12 w-32 rounded-lg" />
      </div>
      
      {/* Contact Info */}
      <div className="space-y-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex gap-4">
            <SkeletonBase className="h-12 w-12 rounded-lg flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <SkeletonBase className="h-5 w-32" />
              <SkeletonBase className="h-4 w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

