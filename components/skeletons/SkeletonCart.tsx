import SkeletonBase from './SkeletonBase';

export default function SkeletonCart() {
  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-6">
      {/* Header */}
      <div className="flex items-center space-x-4 mb-8">
        <SkeletonBase className="h-10 w-10 rounded-lg" />
        <div className="flex-1">
          <SkeletonBase className="h-8 w-48 mb-2" />
          <SkeletonBase className="h-4 w-32" />
        </div>
      </div>

      {/* Trust Indicators */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3 md:gap-6 mb-4 md:mb-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white rounded-lg p-2 sm:p-3 md:p-4 border border-gray-200 flex items-center space-x-2 sm:space-x-3">
            <SkeletonBase className="h-8 w-8 rounded-full flex-shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <SkeletonBase className="h-4 w-24" />
              <SkeletonBase className="h-3 w-16" />
            </div>
          </div>
        ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-8">
        {/* Cart Items Section */}
        <div className="lg:col-span-4 xl:col-span-5 2xl:col-span-5 space-y-6">
          {/* Cart Items Card */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-6">
              <SkeletonBase className="h-6 w-32" />
              <SkeletonBase className="h-5 w-36" />
            </div>

            {/* Cart Item Skeletons */}
            <div className="space-y-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="p-6 border border-gray-200 rounded-lg">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center space-x-3 mb-3">
                        <SkeletonBase className="h-10 w-10 rounded-lg" />
                        <div className="space-y-2">
                          <SkeletonBase className="h-5 w-48" />
                          <SkeletonBase className="h-4 w-36" />
                        </div>
                      </div>
                      
                      {/* Tags */}
                      <div className="flex gap-2 mt-3">
                        <SkeletonBase className="h-6 w-20 rounded-full" />
                        <SkeletonBase className="h-6 w-24 rounded-full" />
                      </div>
                    </div>

                    <div className="flex items-center space-x-6">
                      {/* Period selector */}
                      <div className="space-y-2">
                        <SkeletonBase className="h-4 w-32" />
                        <SkeletonBase className="h-10 w-32 rounded-md" />
                      </div>

                      {/* Price */}
                      <div className="text-right space-y-2">
                        <SkeletonBase className="h-6 w-24" />
                        <SkeletonBase className="h-4 w-20" />
                      </div>

                      {/* Remove button */}
                      <SkeletonBase className="h-8 w-8 rounded-lg" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Add-ons Section */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <SkeletonBase className="h-6 w-48 mb-4" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="flex items-center space-x-3 p-4 border border-gray-200 rounded-lg">
                  <SkeletonBase className="h-10 w-10 rounded-lg flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <SkeletonBase className="h-5 w-32" />
                    <SkeletonBase className="h-4 w-48" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Order Summary Section */}
        <div className="lg:col-span-2 xl:col-span-2 2xl:col-span-3">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <SkeletonBase className="h-6 w-40 mb-6" />

            {/* Summary Items */}
            <div className="space-y-4 mb-6">
              <div className="flex justify-between">
                <SkeletonBase className="h-4 w-32" />
                <SkeletonBase className="h-4 w-20" />
              </div>
              <div className="flex justify-between">
                <SkeletonBase className="h-4 w-24" />
                <SkeletonBase className="h-4 w-20" />
              </div>
              <div className="border-t border-gray-200 pt-4">
                <div className="flex justify-between mb-2">
                  <SkeletonBase className="h-6 w-36" />
                  <SkeletonBase className="h-6 w-24" />
                </div>
                <SkeletonBase className="h-3 w-full" />
              </div>
            </div>

            {/* Checkout Button */}
            <SkeletonBase className="h-12 w-full rounded-lg mb-4" />
            
            {/* Clear Cart Button */}
            <SkeletonBase className="h-10 w-full rounded-lg" />

            {/* Security Badge */}
            <div className="mt-6 pt-6 border-t border-gray-200 flex justify-center">
              <SkeletonBase className="h-5 w-48" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

