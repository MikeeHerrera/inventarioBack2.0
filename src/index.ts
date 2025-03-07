import express, { Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import admin from "firebase-admin";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY as string);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // Usa el bucket correcto: normalmente "tu-proyecto.appspot.com"
  storageBucket: "appbeer-5cb13.firebasestorage.app",
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();
app.use(cors());
app.use(express.json());

/** INTERFACES **/
interface Material {
  name: string;
  cost: number;
  quantity: number;
}

interface SizeOption {
  name: string;
  price: number;
  quantity: number; // Stock para este tamaño
  materials: Material[];
  productionCost?: number; // Costo por unidad, calculado a partir de los materiales
  profit?: number;         // Ganancia por unidad: precio - productionCost
}

interface StockHistory {
  totalStockBefore: number; // Stock del tamaño antes de la actualización
  date: string;
  addedStock: number;
  totalStockAfter: number;  // Stock del tamaño después de la actualización
  notes?: string;
  sizeName: string;
}

interface Product {
  name: string;
  categoryId: string;
  sizes: SizeOption[];
  images: string[];
  stockHistory?: StockHistory[];
}

interface Category {
  name: string;
  image: string;
}

interface OrderItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  subtotal: number;
}

interface Order {
  items: OrderItem[];
  paymentMethod: string;
  total: number;
  date: Date;
}

/** ENDPOINTS **/

// GET /products
app.get("/products", async (req: Request, res: Response) => {
  try {
    const snapshot = await db.collection("inventory").get();
    const products = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));
    return res.json(products);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /products (crear nuevo producto)
app.post("/products", async (req: Request, res: Response) => {
  try {
    const { name, categoryId, sizes } = req.body as Partial<Product> & { categoryId?: string; sizes?: SizeOption[] };

    if (!name) {
      return res.status(400).json({ error: "Falta el nombre del producto." });
    }
    if (!categoryId) {
      return res.status(400).json({ error: "Falta la categoría del producto." });
    }
    if (!sizes || sizes.length === 0) {
      return res.status(400).json({ error: "Debe agregar al menos una opción de tamaño." });
    }

    // Para cada tamaño, calcular el costo de producción y ganancia por unidad
    const processedSizes = sizes.map((size) => {
      const prodCost = size.materials.reduce((sum, m) => sum + m.cost  , 0);
      const profit = size.price - prodCost;
      return { ...size, productionCost: prodCost, profit };
    });

    const newProduct: Product = {
      name,
      categoryId,
      sizes: processedSizes,
      images: [],
      stockHistory: []
    };

    const docRef = await db.collection("inventory").add(newProduct);
    return res.json({ id: docRef.id, ...newProduct });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// PUT /products/:id (actualizar producto)
app.put("/products/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const data = req.body as Partial<Product>;
    // Si se actualizan los tamaños, recalcular productionCost y profit para cada uno
    if (data.sizes) {
      data.sizes = data.sizes.map((size) => {
        const prodCost = size.materials.reduce((sum, m) => sum + m.cost , 0);
        const profit = size.price - prodCost;
        return { ...size, productionCost: prodCost, profit };
      });
    }
    await db.collection("inventory").doc(id).update(data);
    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// PATCH /products/:id/stock (actualizar stock de un tamaño específico)
app.patch("/products/:id/stock", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const { sizeName, quantityDelta, notes } = req.body; // Se espera sizeName
    if (!sizeName) {
      return res.status(400).json({ error: "Debe especificar el tamaño." });
    }
    const productRef = db.collection("inventory").doc(id);
    const snap = await productRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Producto no encontrado." });
    }
    const productData = snap.data() as Product;
    let sizeFound = false;
    const updatedSizes = productData.sizes.map((size) => {
      if (size.name === sizeName) {
        sizeFound = true;
        const newQuantity = size.quantity + quantityDelta;
        if (newQuantity < 0) {
          throw new Error(`Stock negativo no permitido para el tamaño ${sizeName}`);
        }
        const prodCost = size.materials.reduce((sum, m) => sum + m.cost * m.quantity, 0);
        const profit = size.price - prodCost;
        return { ...size, quantity: newQuantity, productionCost: prodCost, profit };
      }
      return size;
    });
    if (!sizeFound) {
      return res.status(404).json({ error: "Tamaño no encontrado en el producto." });
    }
    await productRef.update({ sizes: updatedSizes });
    const logEntry: StockHistory & { productId: string; productName: string; sizeName: string } = {
      date: new Date().toLocaleString(),
      addedStock: quantityDelta,
      totalStockBefore: productData.sizes.find(s => s.name === sizeName)?.quantity ?? 0,
      totalStockAfter: updatedSizes.find(s => s.name === sizeName)?.quantity ?? 0,
      notes: notes || "",
      productId: id,
      productName: productData.name,
      sizeName
    };
    await db.collection("stockLogs").doc().set(logEntry);
    return res.json({ success: true, sizes: updatedSizes, log: logEntry });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// SUBIR IMÁGENES (para productos)
const upload = multer({ storage: multer.memoryStorage() });
app.post("/products/:id/upload", upload.array("images"), async (req: Request, res: Response) => {
  try {
    const productId = req.params.id;
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No se subieron archivos" });
    }
    const imageUrls: string[] = [];
    for (const file of files) {
      const fileName = `${Date.now()}-${file.originalname}`;
      const fileUpload = bucket.file(`products/${productId}/${fileName}`);
      await fileUpload.save(file.buffer, { contentType: file.mimetype });
      await fileUpload.setMetadata({ metadata: { firebaseStorageDownloadTokens: fileName } });
      const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/products%2F${productId}%2F${encodeURIComponent(fileName)}?alt=media&token=${fileName}`;
      imageUrls.push(publicUrl);
    }
    await db.collection("inventory").doc(productId).update({
      images: admin.firestore.FieldValue.arrayUnion(...imageUrls)
    });
    return res.json({ success: true, images: imageUrls });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// ENDPOINTS PEDIDOS
app.get("/orders", async (req: Request, res: Response) => {
  try {
    const snapshot = await db.collection("orders").get();
    const orders = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return res.json(orders);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/orders", async (req: Request, res: Response) => {
  try {
    const { items, paymentMethod, total } = req.body as Partial<Order>;
    if (!items || !paymentMethod || total === undefined) {
      return res.status(400).json({ error: "Faltan datos del pedido." });
    }
    const orderData: Order = {
      items,
      paymentMethod,
      total,
      date: new Date()
    };
    const orderRef = await db.collection("orders").add(orderData);
    // Actualización global del stock (ejemplo: actualizar total sumando stock de tamaños)
    for (const item of items) {
      const productRef = db.collection("inventory").doc(item.productId);
      const snap = await productRef.get();
      if (!snap.exists) continue;
      const product = snap.data() as Product;
      const oldTotal = product.sizes.reduce((sum, s) => sum + s.quantity, 0);
      const newTotal = oldTotal - item.quantity;
      if (newTotal < 0) {
        return res.status(400).json({ error: `Stock insuficiente para ${item.name}` });
      }
      await productRef.update({ totalQuantity: newTotal });
    }

    printOrder(orderData, orderRef.id);

    return res.json({ success: true, orderId: orderRef.id });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

app.delete("/products/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const productRef = db.collection("inventory").doc(id);
    const snap = await productRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Producto no encontrado." });
    }
    await productRef.delete();
    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// NUEVOS ENDPOINTS PARA CATEGORÍAS
app.get("/categories", async (req: Request, res: Response) => {
  try {
    const snapshot = await db.collection("categories").get();
    const categories = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return res.json(categories);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/categories", upload.single("image"), async (req: Request, res: Response) => {
  try {
    const name = req.body.name;
    if (!name) {
      return res.status(400).json({ error: "Falta el nombre de la categoría." });
    }
    let imageUrl = "";
    if (req.file) {
      const fileName = `${Date.now()}-${req.file.originalname}`;
      const fileUpload = bucket.file(`categories/${fileName}`);
      await fileUpload.save(req.file.buffer, { contentType: req.file.mimetype });
      await fileUpload.setMetadata({ metadata: { firebaseStorageDownloadTokens: fileName } });
      imageUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/categories%2F${encodeURIComponent(fileName)}?alt=media&token=${fileName}`;
    }
    const newCategory: Category = { name, image: imageUrl };
    const docRef = await db.collection("categories").add(newCategory);
    return res.json({ id: docRef.id, ...newCategory });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});


// DELETE /products/:id/images (eliminar una imagen de un producto)
app.delete("/products/:id/images", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const { imageUrl } = req.body;
    if (!imageUrl) {
      return res.status(400).json({ error: "No se proporcionó la URL de la imagen." });
    }
    
    // Convertimos la URL en un objeto para extraer el token que usamos como nombre de archivo
    const urlObj = new URL(imageUrl);
    const token = urlObj.searchParams.get("token");
    if (!token) {
      return res.status(400).json({ error: "No se pudo obtener el token de la imagen." });
    }
    
    // El file path es "products/{productId}/{fileName}"
    const filePath = `products/${id}/${token}`;
    const file = bucket.file(filePath);
    
    // Eliminamos el archivo del bucket
    await file.delete();
    
    // Eliminamos la URL del arreglo de imágenes en Firestore
    await db.collection("inventory").doc(id).update({
      images: admin.firestore.FieldValue.arrayRemove(imageUrl)
    });
    
    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});


// Agrega al inicio (o en un módulo aparte)
const escpos = require('escpos');
escpos.Network = require('escpos-network');
// Ya no es necesario configurar el USB para este caso
// escpos.USB = require('escpos-usb');

interface Order {
  items: {
    productId: string;
    name: string;
    price: number;
    quantity: number;
    subtotal: number;
  }[];
  paymentMethod: string;
  total: number;
  date: Date;
}

const printOrder = (order: Order, orderId: string) => {
  // Crea el dispositivo de red usando la IP de la impresora y el puerto (por defecto 9100)
  const device = new escpos.Network('192.168.1.100', 9100);
  const printer = new escpos.Printer(device);
  
  device.open((err: any) => {
    if (err) {
      console.error("Error al conectar la impresora:", err);
      return;
    }
  
    printer
    .hardware('init')
    .raw('\x1B\x33\x00')   // Fuerza line spacing a 0
    .align('ct')
    .text(`---------- ELOTITOS ----------`)
    .text(`Orden #${orderId}`)
    .text(`WhatsApp 2381046602`)
      .text(`Fecha: ${order.date.toLocaleString()}`)
      .text('--------------------------')
      .align('lt')
      .text(`Método de pago: ${order.paymentMethod}`)
      .text(`Total: $${order.total.toFixed(2)}`)
      .text('--------------------------')
            // Establece el interlineado en 0 (si tu impresora lo soporta)
    order.items.forEach((item) => {
      printer.text(`${item.name} x${item.quantity} - $${item.subtotal.toFixed(2)}`);
    });
  
    printer
      .text('--------------------------')
      .align('ct')
      .text('¡Gracias por su compra!')
      .text('                                ')
      .cut('partial') // Intenta un corte parcial
      .close();
  });
  
};


const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API escuchando en http://localhost:${PORT}`);
});
