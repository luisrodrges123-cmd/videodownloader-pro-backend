export function notFound(_req,res){res.status(404).json({error:"Ruta no encontrada."});}
export function errorHandler(err,_req,res,_next){console.error(err);res.status(500).json({error:"Error interno del servidor."});}
