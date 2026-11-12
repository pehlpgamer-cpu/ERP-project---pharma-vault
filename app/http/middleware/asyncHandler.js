/**
 * Express 4 does not catch rejected promises from async handlers. This wrapper forwards both
 * synchronous throws and rejections to `next`, so one bad request can never crash the process.
 */
export default function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    try {
      return Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);

      return undefined;
    }
  };
}
