import {
  Entity,
  PrimaryColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { PurchaseOrderItem } from './purchase-order-item.entity';

// ตรงกับตาราง purchase_order ใน ams_db (PK คือ poNumber ไม่มี id)
@Entity('purchase_order')
export class PurchaseOrder {
  @PrimaryColumn({ length: 50 })
  poNumber: string;

  @Column({ length: 100, nullable: true })
  vendorName: string | null;

  @Column({ type: 'date', nullable: true })
  poDate: string | null;

  @Column({ length: 20, default: 'PENDING' })
  status: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;

  @OneToMany(() => PurchaseOrderItem, (item) => item.purchaseOrder)
  items: Relation<PurchaseOrderItem>[];
}
