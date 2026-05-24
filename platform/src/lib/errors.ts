export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg = 'Bad request') => new AppError(400, 'bad_request', msg);
export const unauthorized = (msg = 'Unauthorized') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Forbidden') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'not_found', msg);
