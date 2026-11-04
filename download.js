import {Router} from "express";
import {validateVideoUrl} from "../services/platforms.js";
const router=Router();
router.post("/",(req,res)=>{
 const result=validateVideoUrl(req.body?.url);
 if(!result.valid)return res.status(400).json({error:result.reason});
 res.status(503).json({error:"Proveedor de descarga no configurado.",platform:result.platform,downloadAvailable:false});
});
export default router;
