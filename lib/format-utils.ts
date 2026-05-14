
/**
 * Formats a number of bytes into a human-readable string (e.g., "1.5 MB", "2 GB").
 * 
 * @param bytes The value to format. Can be a number (in bytes) or a string. 
 *              If a string is provided and no `inputUnit` is specified, it attempts to parse it.
 * @param inputUnit The unit of the input value if it's not bytes. 
 *                  Common for DirectAdmin which often returns values in MB.
 *                  Options: 'B', 'KB', 'MB', 'GB', 'TB'
 * @param decimals Number of decimal places to show. Default is 2.
 */
export function formatBytes(value: number | string, inputUnit: 'B' | 'KB' | 'MB' | 'GB' | 'TB' = 'B', decimals: number = 2): string {
  if (value === undefined || value === null || value === '') return '0 B';
  
  // Handle "unlimited" case
  if (typeof value === 'string' && value.toLowerCase() === 'unlimited') {
    return 'Unlimited';
  }

  let bytes = typeof value === 'string' ? parseFloat(value) : value;

  if (isNaN(bytes)) return '0 B';

  // Convert input to Bytes first
  if (inputUnit === 'KB') bytes *= 1024;
  else if (inputUnit === 'MB') bytes *= 1024 * 1024;
  else if (inputUnit === 'GB') bytes *= 1024 * 1024 * 1024;
  else if (inputUnit === 'TB') bytes *= 1024 * 1024 * 1024 * 1024;

  if (bytes === 0) return '0 B';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
