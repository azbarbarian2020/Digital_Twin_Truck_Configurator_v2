const API_BASE_URL = typeof window !== 'undefined' 
  ? (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000')
  : (process.env.API_URL || 'http://localhost:8000');

export function getApiUrl(path: string): string {
  if (path.startsWith('/api/chat') || 
      path.startsWith('/api/models') || 
      path.startsWith('/api/options') || 
      path.startsWith('/api/configs') || 
      path.startsWith('/api/validate') || 
      path.startsWith('/api/describe')) {
    return `${API_BASE_URL}${path}`;
  }
  return path;
}
