export const runtime = 'edge';

// /changelog is the same dated list as /changes.txt (one line per change or fix).
export function GET(request: Request) {
  return Response.redirect(
    new URL('/changes.txt', request.url).toString(),
    308,
  );
}
