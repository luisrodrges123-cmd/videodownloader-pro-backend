import {Router} from "express";
import {validateVideoUrl} from "./platforms.js";
const router=Router();
router.post("/",(req,res)=>{
 const result=validateVideoUrl(req.body?.url);
 if(!result.valid)return res.status(400).json({error:result.reason});
 res.json({platform:result.platform,valid:true,downloadAvailable:false,message:"Enlace detectado. Falta configurar un proveedor autorizado de descarga."});
});
export default router;
