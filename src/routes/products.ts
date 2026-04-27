import { Router } from "express";
import { z } from "zod";
import { listProducts, getProduct, quotePremium } from "../services/products";
import { HttpError } from "../middlewares/error";

export const productsRouter = Router();

const ProductIdSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "productId must be bytes32 hex");

productsRouter.get("/", async (_req, res, next) => {
  try {
    const products = await listProducts();
    res.json({ count: products.length, products });
  } catch (e) {
    next(e);
  }
});

productsRouter.get("/:productId", async (req, res, next) => {
  try {
    const productId = ProductIdSchema.parse(req.params.productId);
    const p = await getProduct(productId);
    if (!p) throw new HttpError(404, "Product not found", "product_not_found");
    res.json(p);
  } catch (e) {
    next(e);
  }
});

const QuoteQuerySchema = z.object({
  coverageAmount: z.string().regex(/^\d+$/, "coverageAmount must be a positive integer string (USDC base units)"),
});

productsRouter.get("/:productId/quote", async (req, res, next) => {
  try {
    const productId = ProductIdSchema.parse(req.params.productId);
    const { coverageAmount } = QuoteQuerySchema.parse(req.query);
    const q = await quotePremium(productId, BigInt(coverageAmount));
    res.json({ productId, coverageAmount, ...q });
  } catch (e) {
    next(e);
  }
});
