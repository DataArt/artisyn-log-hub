package com.acme.orders;
public class Order {
  private final String id; private double total; private String status = "NEW";
  public Order(String id, double total) { this.id = id; this.total = total; }
  public String getId() { return id; }
  public double getTotal() { return total; }
  public void setStatus(String s) { status = s; }
}
