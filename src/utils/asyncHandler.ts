import { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Envuelve un controlador async para que cualquier promesa rechazada
 * (ej. un fallo de Redis al encolar un job) se propague al middleware de
 * errores de Express en vez de dejar la petición colgada sin respuesta.
 * Sin esto, un error async no manejado nunca llega al cliente: el POS
 * se queda en "Procesando..." para siempre porque el fetch jamás resuelve.
 */
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
